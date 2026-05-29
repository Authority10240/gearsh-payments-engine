import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Currency,
  EscrowEventType,
  EscrowState,
  IntentState,
  LedgerAccount,
  LedgerDirection,
  PayFastPaymentStatus,
  Prisma,
  TransactionState,
  TransactionType,
} from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { PayFastClient } from '../../infra/payfast/payfast.client';
import { isIpAllowed, parseIpWhitelist } from '../../infra/payfast/ip-whitelist';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OutboxService } from '../../events/outbox.service';
import { PaymentsEventType } from '../../events/event-types';
import { roundHalfToEven } from '../fx/fx.service';

/**
 * PayFast posts ITN form params as application/x-www-form-urlencoded. Express
 * parses this into a plain Record<string, string>. We treat everything as
 * string here; downstream we coerce only the integer/decimal fields we need.
 */
export type ItnFormParams = Record<string, string>;

export interface HandleItnInput {
  params: ItnFormParams;
  /** Resolved client IP from Express `req.ip` (after `trust proxy`). */
  sourceIp: string;
  /** Inbound W3C trace context for outbox event correlation. */
  traceparent?: string;
  tracestate?: string;
}

interface NormalisedItn {
  pfPaymentId: string;
  mPaymentId: string;
  paymentStatus: PayFastPaymentStatus;
  /** Gross amount PayFast captured in ZAR (major units string, e.g. "2252.00"). */
  amountGross: string;
  merchantId: string;
}

interface LedgerEntryInput {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: bigint;
}

/**
 * PayFast ITN handler — gearsh-payments-engine.md §PayFast integration "ITN
 * flow", business-rules §8.5 (fee booked at escrow.held), contracts/events
 * (payments.succeeded, escrow.held).
 *
 * Pipeline (each step returns a precise RFC 7807 problem on failure):
 *
 *   1. IP whitelist     → 403 PAYFAST_IP_NOT_WHITELISTED
 *   2. Signature        → 400 PAYFAST_SIGNATURE_INVALID
 *   3. Validate (s2s)   → 400 PAYFAST_VALIDATION_FAILED | 502 PAYFAST_UPSTREAM_FAILURE
 *   4. Intent + amount  → 404 NOT_FOUND | 400 PAYFAST_VALIDATION_FAILED
 *   5. Atomic transition (single $transaction):
 *        - dedup by (paymentIntentId, pfPaymentId, payment_status)
 *        - on COMPLETE: transactions + intent.SUCCEEDED + escrow_holds(HELD)
 *          + escrow_events(HELD) + 3 balanced ledger_entries + 2 outbox rows
 *        - on FAILED:    transactions(FAILED) + intent.FAILED + 1 outbox row
 *          (payments.failed; schema TBD — see TODO below)
 *
 * Returns `{ status: 'ok' }` — PayFast only cares about the 200.
 */
@Injectable()
export class PayFastWebhookService {
  private readonly logger = new Logger(PayFastWebhookService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly payfast: PayFastClient,
    private readonly outbox: OutboxService,
  ) {}

  async handle(input: HandleItnInput): Promise<{ status: 'ok' }> {
    const { params, sourceIp, traceparent, tracestate } = input;

    // ── Step 1: source IP whitelist ──────────────────────────────────────
    const parsed = parseIpWhitelist(this.config.payfast.ipWhitelist);
    // An empty whitelist is treated as "not configured" → reject. In dev
    // the env-var simply lists the published PayFast ranges (see .env.example).
    if (parsed.length === 0 || !isIpAllowed(sourceIp, parsed)) {
      throw new AppException(ErrorCode.PAYFAST_IP_NOT_WHITELISTED, {
        detail: `Source IP ${sourceIp} is not in PAYFAST_IP_WHITELIST.`,
      });
    }

    // ── Step 2: signature ───────────────────────────────────────────────
    const receivedSignature = params['signature'] ?? '';
    if (!this.payfast.verifyItnSignature(params, receivedSignature)) {
      throw new AppException(ErrorCode.PAYFAST_SIGNATURE_INVALID, {
        detail: 'ITN signature did not match the recomputed signature.',
      });
    }

    // ── Step 3: server-to-server validate ───────────────────────────────
    // PayFastClient.validateItn returns true/false on a successful HTTP round-
    // trip and throws PAYFAST_UPSTREAM_FAILURE on axios errors.
    const isValid = await this.payfast.validateItn(params);
    if (!isValid) {
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail: 'PayFast /eng/query/validate did not return VALID.',
      });
    }

    // ── Step 4: intent + amount + merchant match ────────────────────────
    const normalised = this.normaliseItn(params);

    if (normalised.merchantId !== (this.config.payfast.merchantId ?? '')) {
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail: 'ITN merchant_id does not match the configured PAYFAST_MERCHANT_ID.',
      });
    }

    // m_payment_id is the intent uuid. Look it up *before* the atomic step so
    // a NOT_FOUND short-circuits without opening a transaction.
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: normalised.mPaymentId },
    });
    if (!intent) {
      throw new AppException(ErrorCode.NOT_FOUND, {
        detail: `No payment intent matches m_payment_id=${normalised.mPaymentId}.`,
      });
    }

    if (intent.zarAmountCentsLocked === null) {
      // Defensive: the intent must have been /lock'd before PayFast can post.
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail: 'Intent has no locked ZAR amount — was it locked before checkout?',
      });
    }

    const expectedMajor = centsToMajorString(intent.zarAmountCentsLocked);
    if (normalised.amountGross !== expectedMajor) {
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail: `ITN amount_gross=${normalised.amountGross} does not match locked amount ${expectedMajor}.`,
      });
    }

    // Compute the locked fee. Lock-time persistence is the canonical source,
    // but tolerate older intents (pre-PAY-002 schema add) by deriving from
    // (serviceFeeCents × rate) via half-to-even.
    const zarFee = intent.zarServiceFeeCentsLocked ?? this.deriveZarFee(intent);

    // ── Step 5: atomic transition ──────────────────────────────────────
    if (normalised.paymentStatus === PayFastPaymentStatus.COMPLETE) {
      await this.commitComplete({
        intentId: intent.id,
        bookingId: intent.bookingId,
        clientId: intent.userId,
        artistId: intent.artistId,
        currency: intent.currency,
        zarAmount: BigInt(intent.zarAmountCentsLocked),
        zarFee,
        mPaymentId: normalised.mPaymentId,
        pfPaymentId: normalised.pfPaymentId,
        paymentStatus: normalised.paymentStatus,
        rawPayload: params,
        traceparent,
        tracestate,
      });
    } else {
      await this.commitFailed({
        intentId: intent.id,
        bookingId: intent.bookingId,
        clientId: intent.userId,
        artistId: intent.artistId,
        currency: intent.currency,
        zarAmount: BigInt(intent.zarAmountCentsLocked),
        mPaymentId: normalised.mPaymentId,
        pfPaymentId: normalised.pfPaymentId,
        paymentStatus: normalised.paymentStatus,
        rawPayload: params,
        traceparent,
        tracestate,
      });
    }

    return { status: 'ok' };
  }

  // ────────────────────────────────────────────────────────────────────
  // Atomic COMPLETE: transaction + intent.SUCCEEDED + escrow hold(HELD) +
  // escrow event(HELD) + 3 balanced ledger entries + 2 outbox rows.
  // Dedups on the (paymentIntentId, pfPaymentId, paymentStatus) tuple.
  // ────────────────────────────────────────────────────────────────────
  private async commitComplete(args: {
    intentId: string;
    bookingId: string;
    clientId: string;
    artistId: string;
    currency: Currency;
    zarAmount: bigint;
    zarFee: bigint;
    mPaymentId: string;
    pfPaymentId: string;
    paymentStatus: PayFastPaymentStatus;
    rawPayload: ItnFormParams;
    traceparent?: string;
    tracestate?: string;
  }): Promise<void> {
    const escrowHoldAmount = args.zarAmount - args.zarFee;
    if (escrowHoldAmount < 0n) {
      throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
        detail: 'Locked ZAR fee exceeds locked ZAR amount — refusing to create a negative hold.',
      });
    }

    // Sanity-check the ledger BEFORE opening the transaction so a programming
    // error never partially-writes (and the LEDGER_IMBALANCE code is surfaced
    // as a 4xx rather than a 500).
    const entries: LedgerEntryInput[] = [
      {
        account: LedgerAccount.PAYFAST_SETTLEMENT,
        direction: LedgerDirection.DEBIT,
        amountCents: args.zarAmount,
      },
      {
        account: LedgerAccount.ESCROW_LIABILITY,
        direction: LedgerDirection.CREDIT,
        amountCents: escrowHoldAmount,
      },
      {
        account: LedgerAccount.PLATFORM_REVENUE,
        direction: LedgerDirection.CREDIT,
        amountCents: args.zarFee,
      },
    ];
    assertBalanced(entries);

    await this.prisma.$transaction(async (tx) => {
      // Dedup: PayFast retries the ITN until acknowledged. Same (intent,
      // pfPaymentId, status) → no-op. Bare SELECT instead of a unique-upsert
      // so the outbox + ledger writes only fire once.
      const existing = await tx.transaction.findFirst({
        where: {
          paymentIntentId: args.intentId,
          gatewayTxnId: args.pfPaymentId,
          pfPaymentStatus: args.paymentStatus,
        },
        select: { id: true },
      });
      if (existing) {
        this.logger.log(
          `ITN dedup: skipping ${args.paymentStatus} for intent=${args.intentId} pfPaymentId=${args.pfPaymentId}`,
        );
        return;
      }

      const txn = await tx.transaction.create({
        data: {
          paymentIntentId: args.intentId,
          type: TransactionType.CHARGE,
          amountCents: args.zarAmount,
          currency: Currency.ZAR,
          gatewayTxnId: args.pfPaymentId,
          pfPaymentStatus: args.paymentStatus,
          state: TransactionState.SUCCEEDED,
          rawGatewayPayload: args.rawPayload as Prisma.InputJsonValue,
        },
      });

      await tx.paymentIntent.update({
        where: { id: args.intentId },
        data: { state: IntentState.SUCCEEDED, pfPaymentId: args.pfPaymentId },
      });

      const heldAt = new Date();
      const hold = await tx.escrowHold.create({
        data: {
          bookingId: args.bookingId,
          paymentIntentId: args.intentId,
          clientId: args.clientId,
          artistId: args.artistId,
          amountCents: escrowHoldAmount,
          platformFeeCents: args.zarFee,
          currency: Currency.ZAR,
          state: EscrowState.HELD,
          heldAt,
        },
      });

      const event = await tx.escrowEvent.create({
        data: {
          holdId: hold.id,
          type: EscrowEventType.HELD,
          amountCents: escrowHoldAmount,
          actorId: null,
          note: 'PayFast ITN',
        },
      });

      // Three balanced ledger entries scoped to this event:
      //   DEBIT  PAYFAST_SETTLEMENT  zarAmount
      //   CREDIT ESCROW_LIABILITY    zarAmount - zarFee
      //   CREDIT PLATFORM_REVENUE    zarFee
      // Σ DEBITS = Σ CREDITS = zarAmount.
      await tx.ledgerEntry.createMany({
        data: entries.map((e) => ({
          holdId: hold.id,
          eventId: event.id,
          account: e.account,
          direction: e.direction,
          amountCents: e.amountCents,
          currency: Currency.ZAR,
        })),
      });

      // Outbox: payments.succeeded + escrow.held — payloads MATCH
      // contracts/events/schemas/payments.succeeded.json + escrow.held.json.
      await this.outbox.enqueue(tx, {
        aggregateType: 'PaymentIntent',
        aggregateId: args.intentId,
        type: PaymentsEventType.PAYMENTS_SUCCEEDED,
        subject: `payment-intents/${args.intentId}`,
        data: {
          paymentIntentId: args.intentId,
          transactionId: txn.id,
          bookingId: args.bookingId,
          clientId: args.clientId,
          artistId: args.artistId,
          amountCents: Number(args.zarAmount),
          serviceFeeCents: Number(args.zarFee),
          currency: Currency.ZAR,
          gateway: 'PAYFAST',
          gatewayTransactionId: args.pfPaymentId,
          mPaymentId: args.mPaymentId,
          succeededAt: heldAt.toISOString(),
        },
        traceparent: args.traceparent,
        tracestate: args.tracestate,
      });

      await this.outbox.enqueue(tx, {
        aggregateType: 'EscrowHold',
        aggregateId: hold.id,
        type: PaymentsEventType.ESCROW_HELD,
        subject: `escrow-holds/${hold.id}`,
        data: {
          holdId: hold.id,
          bookingId: args.bookingId,
          paymentIntentId: args.intentId,
          clientId: args.clientId,
          artistId: args.artistId,
          amountCents: Number(escrowHoldAmount),
          platformFeeCents: Number(args.zarFee),
          currency: Currency.ZAR,
          heldAt: heldAt.toISOString(),
        },
        traceparent: args.traceparent,
        tracestate: args.tracestate,
      });
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Atomic FAILED (or any non-COMPLETE status): transaction + intent.FAILED
  // + 1 outbox row (payments.failed). No escrow hold, no ledger entries.
  // ────────────────────────────────────────────────────────────────────
  private async commitFailed(args: {
    intentId: string;
    bookingId: string;
    clientId: string;
    artistId: string;
    currency: Currency;
    zarAmount: bigint;
    mPaymentId: string;
    pfPaymentId: string;
    paymentStatus: PayFastPaymentStatus;
    rawPayload: ItnFormParams;
    traceparent?: string;
    tracestate?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findFirst({
        where: {
          paymentIntentId: args.intentId,
          gatewayTxnId: args.pfPaymentId,
          pfPaymentStatus: args.paymentStatus,
        },
        select: { id: true },
      });
      if (existing) {
        this.logger.log(
          `ITN dedup: skipping ${args.paymentStatus} for intent=${args.intentId} pfPaymentId=${args.pfPaymentId}`,
        );
        return;
      }

      const txn = await tx.transaction.create({
        data: {
          paymentIntentId: args.intentId,
          type: TransactionType.CHARGE,
          amountCents: args.zarAmount,
          currency: Currency.ZAR,
          gatewayTxnId: args.pfPaymentId,
          pfPaymentStatus: args.paymentStatus,
          state: TransactionState.FAILED,
          rawGatewayPayload: args.rawPayload as Prisma.InputJsonValue,
        },
      });

      await tx.paymentIntent.update({
        where: { id: args.intentId },
        data: { state: IntentState.FAILED, pfPaymentId: args.pfPaymentId },
      });

      // TODO(orchestrator): contracts/events/schemas/payments.failed.json is
      // not in the contracts tree yet. We emit the same envelope shape as
      // payments.succeeded minus the success-only fields, plus a `reason`
      // pulled from ITN payment_status. Confirm + lock the schema when PAY-003
      // (or a contracts ticket) ships it.
      await this.outbox.enqueue(tx, {
        aggregateType: 'PaymentIntent',
        aggregateId: args.intentId,
        type: PaymentsEventType.PAYMENTS_FAILED,
        subject: `payment-intents/${args.intentId}`,
        data: {
          paymentIntentId: args.intentId,
          transactionId: txn.id,
          bookingId: args.bookingId,
          clientId: args.clientId,
          artistId: args.artistId,
          amountCents: Number(args.zarAmount),
          currency: Currency.ZAR,
          gateway: 'PAYFAST',
          gatewayTransactionId: args.pfPaymentId,
          mPaymentId: args.mPaymentId,
          reason: args.paymentStatus,
          failedAt: new Date().toISOString(),
        },
        traceparent: args.traceparent,
        tracestate: args.tracestate,
      });
    });
  }

  /** Extract + coerce the ITN fields the pipeline depends on. */
  private normaliseItn(params: ItnFormParams): NormalisedItn {
    const pfPaymentId = (params['pf_payment_id'] ?? '').trim();
    const mPaymentId = (params['m_payment_id'] ?? '').trim();
    const statusRaw = (params['payment_status'] ?? '').trim().toUpperCase();
    const amountGross = (params['amount_gross'] ?? '').trim();
    const merchantId = (params['merchant_id'] ?? '').trim();

    if (!pfPaymentId || !mPaymentId || !statusRaw || !amountGross || !merchantId) {
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail:
          'ITN missing one or more required fields: pf_payment_id, m_payment_id, payment_status, amount_gross, merchant_id.',
      });
    }

    if (!isKnownStatus(statusRaw)) {
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail: `Unknown payment_status: ${statusRaw}.`,
      });
    }

    return {
      pfPaymentId,
      mPaymentId,
      paymentStatus: statusRaw,
      amountGross: normaliseAmount(amountGross),
      merchantId,
    };
  }

  /** Derive the ZAR fee from (serviceFeeCents × zarRateLocked) using bankers'
   *  rounding. Fallback only — PAY-002 intents persist zarServiceFeeCentsLocked
   *  at /lock so this path is unreachable for new intents. */
  private deriveZarFee(intent: {
    serviceFeeCents: bigint;
    zarRateLocked: Prisma.Decimal | null;
  }): bigint {
    if (!intent.zarRateLocked) {
      throw new AppException(ErrorCode.PAYFAST_VALIDATION_FAILED, {
        detail: 'Intent has no locked ZAR rate — cannot derive platform fee.',
      });
    }
    const product = new Prisma.Decimal(intent.serviceFeeCents.toString()).mul(intent.zarRateLocked);
    return roundHalfToEven(product);
  }
}

/** ZAR cents → major-units string with two decimals (matches PayFast's
 *  `amount_gross` formatting). Duplicated locally to avoid the controller +
 *  service importing payfast/forms.ts directly. */
function centsToMajorString(amountCents: bigint | number): string {
  const cents = typeof amountCents === 'bigint' ? amountCents : BigInt(amountCents);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const major = abs / 100n;
  const minor = abs % 100n;
  return `${sign}${major}.${minor.toString().padStart(2, '0')}`;
}

/** PayFast historically pads `amount_gross` to two decimals but variants exist
 *  in sandbox; normalise to two-decimal major-unit form. */
function normaliseAmount(raw: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw; // let the caller mismatch fail.
  const [intPart, fracPart = ''] = raw.split('.');
  const padded =
    fracPart.length === 0 ? '00' : fracPart.length === 1 ? `${fracPart}0` : fracPart.slice(0, 2);
  return `${intPart}.${padded}`;
}

function isKnownStatus(s: string): s is PayFastPaymentStatus {
  return s === 'COMPLETE' || s === 'FAILED' || s === 'PENDING' || s === 'CANCELLED';
}

/**
 * Σ DEBITS = Σ CREDITS per event (gearsh-payments-engine.md §Ledger
 * invariants). Exported for unit tests.
 */
export function assertBalanced(entries: LedgerEntryInput[]): void {
  let debits = 0n;
  let credits = 0n;
  for (const e of entries) {
    if (e.amountCents < 0n) {
      throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
        detail: 'Ledger entries must have non-negative amountCents.',
      });
    }
    if (e.direction === LedgerDirection.DEBIT) debits += e.amountCents;
    else credits += e.amountCents;
  }
  if (debits !== credits) {
    throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
      detail: `Σ DEBITS (${debits}) != Σ CREDITS (${credits}).`,
    });
  }
}
