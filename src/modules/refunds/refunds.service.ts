import { Injectable, Logger } from '@nestjs/common';
import {
  EscrowHold,
  EscrowState,
  Prisma,
  Refund,
  RefundState,
  Transaction,
  TransactionType,
} from '@prisma/client';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { buildPage, clampLimit, decodeCursor, type Page } from '../../common/pagination';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  PayFastClient,
  type PayFastRefundFailure,
  type PayFastRefundResult,
} from '../../infra/payfast/payfast.client';
import { OutboxService } from '../../events/outbox.service';
import { PaymentsEventType } from '../../events/event-types';
import { EscrowService } from '../escrow/escrow.service';
import type { FaultParty } from '../escrow/ledger.service';

/**
 * Inputs accepted by RefundsService.issueRefund. PAY-006 subscribers + admin
 * REST routes both land here. Exactly one of `holdId` / `transactionId` must
 * be provided; `full=true` short-circuits refundCents to "everything still
 * refundable on the hold".
 */
export interface IssueRefundInput {
  holdId?: string;
  transactionId?: string;
  refundCents?: bigint;
  full?: boolean;
  reason: string;
  /**
   * Fault attribution drives platform-fee handling on FULL refunds (§8.5).
   * 'NONE' is admin-discretion; the ledger treats it as CLIENT (fee stays
   * with platform) because the platform has not been told to make the client
   * whole. Partial refunds never reverse the fee.
   */
  faultParty: 'CLIENT' | 'ARTIST' | 'NONE';
  actorId: string;
  traceparent?: string;
  tracestate?: string;
}

export interface ListRefundsQuery {
  holdId?: string;
  state?: RefundState;
  limit?: number;
  cursor?: string;
}

export interface RefundEligibility {
  holdId: string;
  canRefund: boolean;
  maxRefundableCents: bigint;
  reason: string | null;
}

/** RFC 7807 reasons surfaced by canRefund. */
type IneligibilityReason =
  | 'NOT_REFUNDABLE_TERMINAL'
  | 'NOT_REFUNDABLE_HOLD_NOT_FOUND'
  | 'NOT_REFUNDABLE_NO_CHARGE_TXN'
  | 'NOT_REFUNDABLE_FULLY_REFUNDED';

/** PayFast retry policy (PAY-004 spec): 3 attempts with exponential backoff. */
const PAYFAST_RETRY_DELAYS_MS = [250, 500, 1_000];
const PAYFAST_MAX_ATTEMPTS = PAYFAST_RETRY_DELAYS_MS.length;

/**
 * Refunds orchestrator (PAY-004). Owns the PayFast Refund API round-trip + the
 * `refunds` row lifecycle + the back-reference onto `escrow_events.refund_id`.
 * Does NOT duplicate the escrow state-machine, ledger, or outbox-event plumbing
 * — those live in EscrowService (PAY-003) and are reused via DI.
 *
 * High-level flow (full and partial):
 *
 *   1. Resolve target hold + CHARGE transaction.
 *   2. Enforce REFUND_EXCEEDS_CAPTURE (refund ≤ amount - already-refunded).
 *   3. Insert refunds row in PROCESSING. The id is the FK we thread onto the
 *      escrow_events row that EscrowService writes a few steps later.
 *   4. Call PayFastClient.refund() with 3-attempt retry policy on 5xx /
 *      network / timeout. 4xx is terminal.
 *   5a. On success: in ONE Prisma transaction, update refunds row → SUCCEEDED
 *       and call EscrowService.refund / partialRefund (which writes the
 *       escrow_events row carrying refundId). Then emit payments.refund.succeeded
 *       outbox row (separate from escrow.refunded / escrow.partially_refunded
 *       which EscrowService already emits).
 *   5b. On failure: update refunds row → FAILED, DO NOT mutate the hold (funds
 *       stay HELD, admin can retry), emit payments.refund.failed outbox row,
 *       throw PAYFAST_UPSTREAM_FAILURE (502) to the caller.
 *
 * Subscribers (PAY-006) call issueRefund(...) directly via DI without going
 * through HTTP. The actorId on subscriber calls is the subscriber-system uuid;
 * the admin REST route passes the authenticated user id.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payfast: PayFastClient,
    private readonly escrow: EscrowService,
    private readonly outbox: OutboxService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // READ surface
  // ────────────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Refund> {
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    if (!refund) throw new AppException(ErrorCode.NOT_FOUND);
    return refund;
  }

  async list(query: ListRefundsQuery): Promise<Page<Refund>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.RefundWhereInput = {};
    if (query.state) where.state = query.state;
    if (query.holdId) {
      // Refunds → transactions → payment_intents → escrow_holds (one hold per
      // intent per booking, PAY-002). We resolve the hold's intent + match on
      // refunds whose transaction belongs to it.
      const hold = await this.prisma.escrowHold.findUnique({
        where: { id: query.holdId },
        select: { paymentIntentId: true },
      });
      if (!hold) {
        return { data: [], pageInfo: { hasNextPage: false, nextCursor: null } };
      }
      where.transaction = { paymentIntentId: hold.paymentIntentId };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.refund.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return buildPage(rows, limit);
  }

  /**
   * Refund-eligibility helper used by the admin UI and the controller pre-flight.
   * Resolves either to "canRefund: true, maxRefundableCents: N" or to a typed
   * reason. Pure-ish: single DB read.
   */
  async canRefund(holdId: string): Promise<RefundEligibility> {
    const hold = await this.prisma.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) {
      return {
        holdId,
        canRefund: false,
        maxRefundableCents: 0n,
        reason: 'NOT_REFUNDABLE_HOLD_NOT_FOUND' satisfies IneligibilityReason,
      };
    }
    if (hold.state === EscrowState.RELEASED || hold.state === EscrowState.REFUNDED) {
      return {
        holdId,
        canRefund: false,
        maxRefundableCents: 0n,
        reason: 'NOT_REFUNDABLE_TERMINAL' satisfies IneligibilityReason,
      };
    }
    const remaining = hold.amountCents - hold.partiallyRefundedAmountCents;
    if (remaining <= 0n) {
      return {
        holdId,
        canRefund: false,
        maxRefundableCents: 0n,
        reason: 'NOT_REFUNDABLE_FULLY_REFUNDED' satisfies IneligibilityReason,
      };
    }
    // We also assert there's a CHARGE transaction (the PayFast round-trip
    // needs the pf_payment_id). DISPUTED is still refundable in the eligibility
    // sense, but the escrow state-machine will reject the transition — admin
    // sees that as a separate error from the resolution route.
    const charge = await this.prisma.transaction.findFirst({
      where: { paymentIntentId: hold.paymentIntentId, type: TransactionType.CHARGE },
      select: { id: true },
    });
    if (!charge) {
      return {
        holdId,
        canRefund: false,
        maxRefundableCents: 0n,
        reason: 'NOT_REFUNDABLE_NO_CHARGE_TXN' satisfies IneligibilityReason,
      };
    }
    return { holdId, canRefund: true, maxRefundableCents: remaining, reason: null };
  }

  // ────────────────────────────────────────────────────────────────────────
  // MAIN ENTRY POINT
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Issue a refund — full or partial — by:
   *
   *   (1) resolving the escrow hold + originating CHARGE transaction,
   *   (2) doing the PayFast Refund API round-trip with retries OUTSIDE any
   *       DB transaction (axios I/O can't be rolled back),
   *   (3) on success, in a single $transaction: update the refunds row to
   *       SUCCEEDED + call EscrowService.refund/partialRefund with the refund
   *       id threaded through so escrow_events.refund_id is set + enqueue
   *       payments.refund.succeeded outbox row.
   *
   * On failure: refunds row → FAILED, NO escrow mutation, payments.refund.failed
   * outbox row, 502 PAYFAST_UPSTREAM_FAILURE to the caller.
   */
  async issueRefund(input: IssueRefundInput): Promise<Refund> {
    // ── Step 1: resolve hold + charge ───────────────────────────────────
    const { hold, chargeTxn } = await this.resolveHoldAndCharge(input);

    // ── Step 2: cap the refund + decide full vs partial ────────────────
    const remaining = hold.amountCents - hold.partiallyRefundedAmountCents;
    if (remaining <= 0n) {
      throw new AppException(ErrorCode.ILLEGAL_TRANSITION, {
        detail: 'Hold has no refundable balance remaining.',
      });
    }
    if (hold.state === EscrowState.RELEASED || hold.state === EscrowState.REFUNDED) {
      throw new AppException(ErrorCode.ILLEGAL_TRANSITION, {
        detail: `Hold ${hold.id} is in terminal state ${hold.state}.`,
      });
    }
    const isFull = input.full === true || input.refundCents === undefined;
    const refundCents = isFull ? remaining : (input.refundCents ?? 0n);
    if (refundCents <= 0n) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'refundCents must be a positive integer (or set full=true).',
      });
    }
    if (refundCents > remaining) {
      throw new AppException(ErrorCode.REFUND_EXCEEDS_CAPTURE, {
        detail: `Refund amount ${refundCents} exceeds refundable balance ${remaining}.`,
      });
    }
    // A "full" refund is one where the refund cents covers the entire remaining
    // refundable balance — important for §8.5 fee handling on artist-fault.
    const refundIsFull = refundCents === remaining;

    if (!chargeTxn.gatewayTxnId) {
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: `Charge transaction ${chargeTxn.id} has no pf_payment_id — cannot call Refund API.`,
      });
    }

    // ── Step 3: insert refunds row in PROCESSING ───────────────────────
    const refund = await this.prisma.refund.create({
      data: {
        transactionId: chargeTxn.id,
        amountCents: refundCents,
        reason: input.reason,
        initiatedBy: input.actorId,
        state: RefundState.PROCESSING,
      },
    });

    // ── Step 4: PayFast call with retry ────────────────────────────────
    const gatewayResult = await this.callPayFastWithRetry({
      pfPaymentId: chargeTxn.gatewayTxnId,
      amountCents: refundCents,
      reason: input.reason,
    });

    if (!gatewayResult.ok) {
      // ── Step 5b: gateway FAILURE ─────────────────────────────────────
      const failed = await this.handleGatewayFailure(
        refund,
        hold,
        refundCents,
        gatewayResult,
        input,
      );
      this.logger.warn(
        `Refund FAILED refundId=${failed.id} holdId=${hold.id} reason=${gatewayResult.reason}`,
      );
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: `PayFast refund failed for refundId=${failed.id}: ${gatewayResult.reason}`,
      });
    }

    // ── Step 5a: gateway SUCCESS — flip escrow + finalise refund ──────
    return this.handleGatewaySuccess({
      refund,
      hold,
      chargeTxn,
      refundCents,
      refundIsFull,
      gatewayResult,
      input,
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /** Resolve the target hold + its originating CHARGE transaction. The hold
   *  must be in a non-terminal state for the caller's state-machine check to
   *  succeed later; we only enforce NOT_FOUND here so the surface error mirrors
   *  the spec table (404 NOT_FOUND, 409 ILLEGAL_TRANSITION). */
  private async resolveHoldAndCharge(
    input: IssueRefundInput,
  ): Promise<{ hold: EscrowHold; chargeTxn: Transaction }> {
    if (!input.holdId && !input.transactionId) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'One of holdId or transactionId is required.',
      });
    }

    let hold: EscrowHold | null = null;
    let charge: Transaction | null = null;

    if (input.holdId) {
      hold = await this.prisma.escrowHold.findUnique({ where: { id: input.holdId } });
      if (!hold) {
        throw new AppException(ErrorCode.NOT_FOUND, {
          detail: `No escrow hold ${input.holdId}.`,
        });
      }
      // Find the most-recent successful CHARGE transaction for the intent. PAY-
      // 002's webhook always writes exactly one COMPLETE CHARGE per intent; if
      // the spec ever supports re-charges we'll pick the most recent SUCCEEDED
      // one.
      charge = await this.prisma.transaction.findFirst({
        where: {
          paymentIntentId: hold.paymentIntentId,
          type: TransactionType.CHARGE,
        },
        orderBy: { createdAt: 'desc' },
      });
    } else if (input.transactionId) {
      charge = await this.prisma.transaction.findUnique({ where: { id: input.transactionId } });
      if (!charge || charge.type !== TransactionType.CHARGE) {
        throw new AppException(ErrorCode.NOT_FOUND, {
          detail: `No CHARGE transaction ${input.transactionId}.`,
        });
      }
      hold = await this.prisma.escrowHold.findFirst({
        where: { paymentIntentId: charge.paymentIntentId },
      });
    }

    if (!hold) {
      throw new AppException(ErrorCode.NOT_FOUND, {
        detail: 'No escrow hold found for the target transaction.',
      });
    }
    if (!charge) {
      throw new AppException(ErrorCode.NOT_FOUND, {
        detail: `No CHARGE transaction for intent ${hold.paymentIntentId}.`,
      });
    }
    return { hold, chargeTxn: charge };
  }

  /** PayFast Refund API call wrapped in the spec's 3-attempt exponential
   *  back-off (250ms / 500ms / 1s). 4xx is terminal; 5xx / network / timeout
   *  is retriable. The PayFastClient does the discriminated-result mapping. */
  private async callPayFastWithRetry(input: {
    pfPaymentId: string;
    amountCents: bigint;
    reason?: string;
  }): Promise<PayFastRefundResult> {
    let lastFailure: PayFastRefundFailure | null = null;
    for (let attempt = 0; attempt < PAYFAST_MAX_ATTEMPTS; attempt++) {
      const result = await this.payfast.refund(input);
      if (result.ok) return result;
      if (!result.retriable) return result; // 4xx → terminal
      lastFailure = result;
      if (attempt < PAYFAST_MAX_ATTEMPTS - 1) {
        await sleep(PAYFAST_RETRY_DELAYS_MS[attempt]);
      }
    }
    // All 3 retriable attempts exhausted.
    return (
      lastFailure ?? {
        ok: false,
        retriable: true,
        reason: 'PayFast refund retries exhausted.',
        rawResponse: null,
      }
    );
  }

  /** Persist the FAILED refund row + emit the payments.refund.failed outbox
   *  row. The escrow hold is NOT mutated — funds stay HELD, an admin can
   *  retry from the same hold. */
  private async handleGatewayFailure(
    refund: Refund,
    hold: EscrowHold,
    refundCents: bigint,
    failure: PayFastRefundFailure,
    input: IssueRefundInput,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const failed = await tx.refund.update({
        where: { id: refund.id },
        data: {
          state: RefundState.FAILED,
          failureReason: truncate(failure.reason, 1_000),
          gatewayResponsePayload: toJson(failure.rawResponse),
        },
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'Refund',
        aggregateId: refund.id,
        // TODO(orchestrator): event schema missing — payments.refund.failed.json
        // is not committed to contracts/events/schemas/ yet. Payload mirrors the
        // shape sketched in gearsh-payments-engine.md §Events.
        type: PaymentsEventType.PAYMENTS_REFUND_FAILED,
        subject: `refunds/${refund.id}`,
        data: {
          refundId: refund.id,
          transactionId: refund.transactionId,
          paymentIntentId: hold.paymentIntentId,
          bookingId: hold.bookingId,
          amountCents: Number(refundCents),
          currency: hold.currency,
          failureReason: failure.reason,
          failedAt: new Date().toISOString(),
        },
        traceparent: input.traceparent,
        tracestate: input.tracestate,
      });
      return failed;
    });
  }

  /** Persist the SUCCEEDED refund row + flip the escrow state (delegated to
   *  EscrowService) + emit the payments.refund.succeeded outbox row. All in
   *  one Prisma transaction. */
  private async handleGatewaySuccess(args: {
    refund: Refund;
    hold: EscrowHold;
    chargeTxn: Transaction;
    refundCents: bigint;
    refundIsFull: boolean;
    gatewayResult: PayFastRefundResult & { ok: true };
    input: IssueRefundInput;
  }): Promise<Refund> {
    const { refund, hold, chargeTxn, refundCents, refundIsFull, gatewayResult, input } = args;
    const completedAt = new Date();
    const ledgerFault: FaultParty = input.faultParty === 'ARTIST' ? 'ARTIST' : 'CLIENT';

    return this.prisma.$transaction(async (tx) => {
      // (1) Finalise the refund row.
      const succeeded = await tx.refund.update({
        where: { id: refund.id },
        data: {
          state: RefundState.SUCCEEDED,
          gatewayRefundId: gatewayResult.refundId,
          gatewayResponsePayload: toJson(gatewayResult.rawResponse),
          completedAt,
        },
      });

      // (2) Flip escrow state. EscrowService runs its own $transaction
      //     INTERNALLY — Postgres flattens nested Prisma $transaction calls so
      //     this still commits atomically with the refund row update.
      //     The refundId threaded through lands on escrow_events.refund_id
      //     (PAY-004 EscrowService extension).
      if (refundIsFull) {
        await this.escrow.refund(hold.id, {
          faultParty: ledgerFault,
          reason: input.reason,
          actorId: input.actorId,
          note: input.reason,
          traceparent: input.traceparent,
          tracestate: input.tracestate,
          refundId: refund.id,
        });
      } else {
        await this.escrow.partialRefund(hold.id, refundCents, {
          faultParty: ledgerFault,
          reason: input.reason,
          actorId: input.actorId,
          traceparent: input.traceparent,
          tracestate: input.tracestate,
          refundId: refund.id,
        });
      }

      // (3) payments.refund.succeeded outbox row — separate from the
      //     escrow.refunded / escrow.partially_refunded the EscrowService
      //     already enqueued. Two distinct subjects → two distinct subscriber
      //     concerns (notifications watching refunds, reconciliation watching
      //     escrow).
      await this.outbox.enqueue(tx, {
        aggregateType: 'Refund',
        aggregateId: refund.id,
        // TODO(orchestrator): event schema missing —
        // contracts/events/schemas/payments.refund.succeeded.json is not
        // committed yet. Payload shape from gearsh-payments-engine.md §Events.
        type: PaymentsEventType.PAYMENTS_REFUND_SUCCEEDED,
        subject: `refunds/${refund.id}`,
        data: {
          refundId: refund.id,
          transactionId: chargeTxn.id,
          paymentIntentId: hold.paymentIntentId,
          bookingId: hold.bookingId,
          amountCents: Number(refundCents),
          currency: hold.currency,
          gatewayRefundId: gatewayResult.refundId,
          succeededAt: completedAt.toISOString(),
          faultParty: input.faultParty,
        },
        traceparent: input.traceparent,
        tracestate: input.tracestate,
      });

      return succeeded;
    });
  }
}

/** Promise-based sleep used by the retry policy. Extracted so the unit spec
 *  can mock it out (jest fake timers). */
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
