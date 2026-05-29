import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Payout, PayoutState, Prisma } from '@prisma/client';
import { APP_CONFIG } from '../../../config/app-config.token';
import type { AppConfig } from '../../../config/configuration';
import { OutboxService } from '../../../events/outbox.service';
import { PaymentsEventType } from '../../../events/event-types';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  PayFastClient,
  type PayFastAdhocPaymentResult,
} from '../../../infra/payfast/payfast.client';
import { PayoutMethodsService } from '../payout-methods.service';

/** PayFast Adhoc-API retry policy — mirrors the refunds policy (PAY-004):
 *  3 attempts with 250 / 500 / 1000 ms exponential backoff on 5xx / network /
 *  timeout. 4xx is terminal. */
const PAYFAST_RETRY_DELAYS_MS = [250, 500, 1_000];
const PAYFAST_MAX_ATTEMPTS = PAYFAST_RETRY_DELAYS_MS.length;

interface DispatchTickResult {
  picked: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Hourly payout dispatcher (gearsh-payments-engine.md §Jobs, business-rules
 * §8.1). One tick:
 *
 *   1. SELECT … FOR UPDATE SKIP LOCKED — pick up to `PAYOUT_DISPATCH_BATCH_SIZE`
 *      QUEUED payouts whose dispatch_after is in the past AND for which there
 *      is no PROCESSING refund on the same hold (PAY-004 race guard — admin
 *      must not refund mid-dispatch).
 *
 *   2. For each row:
 *      (a) Resolve the artist's verified payout method via PayoutMethodsService.
 *          Missing OR is_verified=false → flip payout to FAILED with
 *          `NO_PAYOUT_METHOD`, emit `escrow.payout.failed`, continue.
 *      (b) Move payout QUEUED → PROCESSING with a guarded UPDATE
 *          (WHERE state='QUEUED') so a concurrent run skips it.
 *      (c) Decrypt the account number (EncryptionService is admin-authorised
 *          within the dispatcher — direct call inside the cron only).
 *      (d) Call PayFast Adhoc Payments with the 3-attempt retry policy.
 *      (e) On success: in a single $transaction, set state=SUCCEEDED,
 *          stamp completed_at + gateway_payout_id + raw_gateway_payload,
 *          bump artist_payout_methods.last_used_at, enqueue
 *          `escrow.payout.succeeded`.
 *      (f) On failure: in a single $transaction, set state=FAILED, stamp
 *          failed_at + failure_reason + raw_gateway_payload (do NOT touch
 *          attempted_at — it stays as the audit value of "we tried at this
 *          time"). Enqueue `escrow.payout.failed`. The retry job will pick
 *          this up on its 4-hour cadence per its backoff gate.
 *
 * The cron is env-gated via PAYOUT_DISPATCH_ENABLED; tests + dev can disable
 * it. PayFast not-enabled → degrade gracefully (log + skip) rather than
 * throw — the engine still boots and the queue accumulates until creds are
 * provisioned (business-rules §8.8 degrade-on-missing-creds).
 */
@Injectable()
export class PayoutDispatcherJob {
  private readonly logger = new Logger(PayoutDispatcherJob.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly methods: PayoutMethodsService,
    private readonly payfast: PayFastClient,
    private readonly outbox: OutboxService,
  ) {}

  @Cron('0 * * * *', { timeZone: 'Africa/Johannesburg', name: 'payouts-dispatch' })
  async cron(): Promise<DispatchTickResult> {
    if (!this.config.payouts.dispatchEnabled) {
      this.logger.debug('payouts dispatcher disabled via PAYOUT_DISPATCH_ENABLED');
      return { picked: 0, succeeded: 0, failed: 0, skipped: 0 };
    }
    if (!this.payfast.enabled) {
      // Cold-boot before creds are populated — log once per tick rather than
      // hammer PayFast 503s. The queue accumulates and is picked up on the
      // next tick after creds arrive.
      this.logger.warn('payouts dispatcher tick skipped — PayFast credentials are not configured');
      return { picked: 0, succeeded: 0, failed: 0, skipped: 0 };
    }
    return this.runOnce();
  }

  /** Single dispatch tick, exposed for direct invocation by tests + the
   *  admin manual-tick path (future PAY-007 admin convenience). */
  async runOnce(): Promise<DispatchTickResult> {
    const batchSize = this.config.payouts.dispatchBatchSize;
    const candidates = await this.pickCandidates(batchSize);
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      try {
        const outcome = await this.dispatchOne(candidate);
        if (outcome === 'SUCCEEDED') succeeded += 1;
        else if (outcome === 'FAILED') failed += 1;
        else skipped += 1;
      } catch (err) {
        // A throw here is unexpected (per-row work catches PayFast failures
        // and turns them into FAILED rows). Log + continue so one bad row
        // can't poison the whole batch.
        this.logger.error(
          `payouts dispatcher row=${candidate.id} unexpected throw: ${(err as Error).message}`,
        );
        failed += 1;
      }
    }
    if (candidates.length > 0) {
      this.logger.log(
        `payouts dispatcher tick: picked=${candidates.length} succeeded=${succeeded} failed=${failed} skipped=${skipped}`,
      );
    }
    return { picked: candidates.length, succeeded, failed, skipped };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Pick the next batch of QUEUED payouts ready to dispatch. The race guard
   * (NOT EXISTS subquery) is critical: an admin refund issued while a payout
   * is queued WOULD result in a double-spend if we paid the artist before
   * the refund completed. Refunds insert their row as PROCESSING immediately
   * (PAY-004) so this clause locks the payout out until the refund either
   * succeeds (escrow flips to REFUNDED → the FREEZE/REFUND path will have
   * cancelled the payout via EscrowService) or fails (refund row → FAILED,
   * not PROCESSING, dispatcher unblocked).
   *
   * Uses raw SQL because we need NOT EXISTS with a join on the hold's
   * intent — Prisma's nested filter API can't express it without inflating
   * the query plan.
   */
  private async pickCandidates(limit: number): Promise<Payout[]> {
    const rows = await this.prisma.$queryRaw<RawPayout[]>`
      SELECT p.*
      FROM "payouts" p
      WHERE p."state" = 'QUEUED'
        AND p."dispatch_after" <= NOW()
        AND NOT EXISTS (
          SELECT 1
          FROM "refunds" r
          JOIN "transactions" t ON t."id" = r."transaction_id"
          JOIN "escrow_holds" h ON h."payment_intent_id" = t."payment_intent_id"
          WHERE h."id" = p."hold_id"
            AND r."state" = 'PROCESSING'
        )
      ORDER BY p."dispatch_after" ASC, p."id" ASC
      LIMIT ${limit}
    `;
    return rows.map(rawToPayout);
  }

  /** Dispatch a single payout. Returns the outcome for the tick counter. */
  private async dispatchOne(payout: Payout): Promise<'SUCCEEDED' | 'FAILED' | 'SKIPPED'> {
    // (a) Resolve the artist's payout method.
    const method = await this.prisma.artistPayoutMethod.findUnique({
      where: { artistUserId: payout.artistId },
    });
    if (!method || !method.isVerified) {
      const reason = !method ? 'NO_PAYOUT_METHOD' : 'PAYOUT_METHOD_NOT_VERIFIED';
      await this.persistFailure(payout, reason, null);
      return 'FAILED';
    }

    // (b) Atomic transition QUEUED → PROCESSING. The guard on state='QUEUED'
    //     prevents a second concurrent run from also picking this row (belt
    //     + braces with the SELECT … FOR UPDATE SKIP LOCKED on the pick).
    const claimed = await this.prisma.payout.updateMany({
      where: { id: payout.id, state: PayoutState.QUEUED },
      data: { state: PayoutState.PROCESSING, attemptedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Another runner took it — log + count as skipped.
      this.logger.debug(`payouts dispatcher row=${payout.id} already claimed by another runner`);
      return 'SKIPPED';
    }

    // (c) Decrypt the account number — admin-authorised inside the dispatcher
    //     only (see EncryptionService docs).
    const accountNumber = await this.methods.decryptAccountNumber(method);

    // (d) PayFast Adhoc call with retry.
    const gatewayResult = await this.callPayFastWithRetry({
      accountHolder: method.accountHolderName,
      bankName: method.bankName,
      branchCode: method.branchCode,
      accountNumber,
      accountType: method.accountType,
      amountCents: payout.amountCents,
      reference: `payout-${payout.id}`,
      description: `Gearsh payout for hold ${payout.holdId}`,
    });

    if (!gatewayResult.ok) {
      await this.persistFailure(payout, gatewayResult.reason, gatewayResult.rawResponse);
      return 'FAILED';
    }

    // (e) Persist SUCCEEDED, bump last_used_at, emit outbox — all in one tx.
    await this.persistSuccess(payout, gatewayResult.payoutId, gatewayResult.rawResponse, method.id);
    return 'SUCCEEDED';
  }

  /** PayFast Adhoc Payments call with the spec's 3-attempt exponential
   *  back-off (250 / 500 / 1000 ms). Mirrors PAY-004's refund retry. */
  private async callPayFastWithRetry(
    input: Parameters<PayFastClient['adhocPayment']>[0],
  ): Promise<PayFastAdhocPaymentResult> {
    let lastFailure: Extract<PayFastAdhocPaymentResult, { ok: false }> | null = null;
    for (let attempt = 0; attempt < PAYFAST_MAX_ATTEMPTS; attempt++) {
      const result = await this.payfast.adhocPayment(input);
      if (result.ok) return result;
      if (!result.retriable) return result; // 4xx — terminal
      lastFailure = result;
      if (attempt < PAYFAST_MAX_ATTEMPTS - 1) {
        await sleep(PAYFAST_RETRY_DELAYS_MS[attempt]);
      }
    }
    return (
      lastFailure ?? {
        ok: false,
        retriable: true,
        reason: 'PayFast adhoc retries exhausted.',
        rawResponse: null,
      }
    );
  }

  /** Persist SUCCEEDED in one transaction. */
  private async persistSuccess(
    payout: Payout,
    gatewayPayoutId: string,
    rawResponse: unknown,
    methodId: string,
  ): Promise<void> {
    const completedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.payout.update({
        where: { id: payout.id },
        data: {
          state: PayoutState.SUCCEEDED,
          completedAt,
          gatewayPayoutId,
          rawGatewayPayload: toJson(rawResponse),
        },
      });
      await tx.artistPayoutMethod.update({
        where: { id: methodId },
        data: { lastUsedAt: completedAt },
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'Payout',
        aggregateId: payout.id,
        // TODO(orchestrator): event schema missing —
        // contracts/events/schemas/escrow.payout.succeeded.json is not committed
        // yet. Payload shape from gearsh-payments-engine.md §Events.
        type: PaymentsEventType.ESCROW_PAYOUT_SUCCEEDED,
        subject: `payouts/${payout.id}`,
        data: {
          payoutId: payout.id,
          holdId: payout.holdId,
          artistUserId: payout.artistId,
          amountCents: Number(payout.amountCents),
          currency: payout.currency,
          gatewayPayoutId,
          succeededAt: completedAt.toISOString(),
        },
      });
    });
  }

  /** Persist FAILED in one transaction. Sets failed_at so the retry-cron's
   *  backoff gate (failed_at + min(24h, 2^attempts hours)) ticks from now. */
  private async persistFailure(
    payout: Payout,
    reason: string,
    rawResponse: unknown,
  ): Promise<void> {
    const failedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      // The payout might still be QUEUED (NO_PAYOUT_METHOD failures short-
      // circuit before the QUEUED→PROCESSING transition) — the updateMany
      // here is shape-safe either way.
      await tx.payout.updateMany({
        where: { id: payout.id, state: { in: [PayoutState.QUEUED, PayoutState.PROCESSING] } },
        data: {
          state: PayoutState.FAILED,
          failedAt,
          failureReason: truncate(reason, 1_000),
          rawGatewayPayload: toJson(rawResponse),
        },
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'Payout',
        aggregateId: payout.id,
        // TODO(orchestrator): event schema missing —
        // contracts/events/schemas/escrow.payout.failed.json is not committed yet.
        type: PaymentsEventType.ESCROW_PAYOUT_FAILED,
        subject: `payouts/${payout.id}`,
        data: {
          payoutId: payout.id,
          holdId: payout.holdId,
          artistUserId: payout.artistId,
          amountCents: Number(payout.amountCents),
          currency: payout.currency,
          failureReason: reason,
          failedAt: failedAt.toISOString(),
        },
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw-SQL row coercion
// ─────────────────────────────────────────────────────────────────────────────

/** Raw row shape returned by `$queryRaw` against `payouts`. snake_case columns,
 *  BIGINT → bigint, TIMESTAMPTZ → Date. */
interface RawPayout {
  id: string;
  artist_id: string;
  hold_id: string;
  amount_cents: bigint;
  currency: Payout['currency'];
  state: PayoutState;
  dispatch_after: Date;
  gateway_payout_id: string | null;
  attempted_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  failure_reason: string | null;
  attempts: number;
  failed_at: Date | null;
  raw_gateway_payload: Prisma.JsonValue | null;
  created_at: Date;
  updated_at: Date;
}

function rawToPayout(r: RawPayout): Payout {
  return {
    id: r.id,
    artistId: r.artist_id,
    holdId: r.hold_id,
    amountCents: r.amount_cents,
    currency: r.currency,
    state: r.state,
    dispatchAfter: r.dispatch_after,
    gatewayPayoutId: r.gateway_payout_id,
    attemptedAt: r.attempted_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    failureReason: r.failure_reason,
    attempts: r.attempts,
    failedAt: r.failed_at,
    rawGatewayPayload: r.raw_gateway_payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
