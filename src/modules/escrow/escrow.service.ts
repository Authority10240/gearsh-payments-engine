import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EscrowEvent,
  EscrowEventType,
  EscrowHold,
  EscrowState,
  PayoutState,
  Prisma,
} from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { buildPage, clampLimit, decodeCursor, type Page } from '../../common/pagination';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OutboxService } from '../../events/outbox.service';
import { PaymentsEventType } from '../../events/event-types';
import { type EscrowAction, canTransition, nextState } from './escrow-state.machine';
import { LedgerService, type LedgerEntryInput, type FaultParty } from './ledger.service';

/**
 * Common options threaded onto every state-changing call. `actorId` is the
 * admin user (when the route is admin-driven) or null (when the call originates
 * from a subscriber — PAY-006). `traceparent`/`tracestate` propagate W3C trace
 * context onto the outbox row so the published Pub/Sub event is correlated
 * with the inbound HTTP request.
 */
export interface MutationContext {
  actorId?: string | null;
  note?: string | null;
  traceparent?: string;
  tracestate?: string;
}

export interface RefundOptions extends MutationContext {
  faultParty: FaultParty;
  reason?: string | null;
  /**
   * Optional FK back to the `refunds` row that triggered this transition. PAY-
   * 004's RefundsService passes the id of the refund row it just inserted; the
   * EscrowService persists it onto escrow_events.refund_id inside the same DB
   * transaction. Subscriber-driven refunds (PAY-006) that go through the
   * RefundsService get this populated too; direct admin /escrow/holds/:id/refund
   * calls (no PayFast round-trip) leave it NULL.
   */
  refundId?: string | null;
}

export interface FreezeOptions extends MutationContext {
  reason: string;
}

export interface ResolveOptions extends MutationContext {
  resolutionNotes?: string | null;
}

export interface ListHoldsQuery {
  artistId?: string;
  state?: EscrowState;
  limit?: number;
  cursor?: string;
}

interface ApplyTransitionArgs {
  holdId: string;
  action: EscrowAction;
  ctx: MutationContext;
  /**
   * Computes side-effects against the locked hold. Returns the new state
   * delta + the ledger entries (one logical event = one ledger event id) +
   * outbox rows to enqueue. All run inside the same $transaction.
   */
  work: (tx: Prisma.TransactionClient, hold: EscrowHold, target: EscrowState) => Promise<void>;
}

/**
 * Escrow lifecycle orchestrator (PAY-003) — owns the state-machine + ledger +
 * outbox stitching for every hold mutation. Every method:
 *
 *   1. Opens a $transaction (Serializable so two concurrent admin actions on
 *      the same hold serialise; on Postgres we additionally pin the row with
 *      `SELECT … FOR UPDATE` before reading other state).
 *   2. Validates the transition through escrow-state.machine.ts.
 *   3. Updates escrow_holds, inserts an escrow_events row (one per logical
 *      action), inserts the matching balanced ledger_entries, queues/cancels
 *      payouts per business-rules §8.1, and enqueues an outbox event.
 *   4. assertBalanced() is called per event before commit — failure throws
 *      LEDGER_IMBALANCE; it's a 409 to the client but the real signal is the
 *      logger.error + alert.
 *
 * Subscribers (PAY-006) will call release/refund/freeze/resolve* directly with
 * actorId=null. The admin REST routes call them with actorId = req.user.sub.
 */
@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // READ surface (admin routes)
  // ────────────────────────────────────────────────────────────────────────

  async getById(holdId: string): Promise<EscrowHold> {
    const hold = await this.prisma.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw new AppException(ErrorCode.NOT_FOUND);
    return hold;
  }

  async list(query: ListHoldsQuery): Promise<Page<EscrowHold>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.EscrowHoldWhereInput = {};
    if (query.artistId) where.artistId = query.artistId;
    if (query.state) where.state = query.state;
    // Stable keyset (createdAt desc, id desc) — matches encodeCursor()'s shape.
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.escrowHold.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // sentinel for hasNextPage
    });
    return buildPage(rows, limit);
  }

  // ────────────────────────────────────────────────────────────────────────
  // MUTATIONS
  // ────────────────────────────────────────────────────────────────────────

  /**
   * RELEASE a HELD (or PARTIALLY_REFUNDED — paying the remainder) hold to the
   * artist. Queues a payouts row with dispatch_after = now + DISPUTE_WINDOW_DAYS
   * (business-rules §8.1). Emits escrow.released.
   */
  async release(holdId: string, opts: MutationContext = {}): Promise<EscrowHold> {
    return this.applyTransition({
      holdId,
      action: 'RELEASE',
      ctx: opts,
      work: async (tx, hold, target) => {
        const remainder = hold.amountCents - hold.partiallyRefundedAmountCents;
        if (remainder < 0n) {
          throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
            detail: 'Partially refunded amount exceeds held amount — refusing to release.',
          });
        }

        const releasedAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: { state: target, releasedAt },
        });
        const event = await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.RELEASED,
            amountCents: remainder,
            actorId: opts.actorId ?? null,
            note: opts.note ?? null,
          },
        });
        await this.writeLedger(
          tx,
          updated,
          event,
          this.ledger.buildReleaseEntriesForAmount(remainder),
        );
        await this.queuePayout(tx, updated, remainder, releasedAt);
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — contracts/events/schemas/
          // escrow.released.json is not committed yet. Payload shape defined in
          // gearsh-payments-engine.md §Events: escrow.released.
          type: PaymentsEventType.ESCROW_RELEASED,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            artistId: hold.artistId,
            amountCents: Number(remainder),
            currency: hold.currency,
            releasedAt: releasedAt.toISOString(),
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
      },
    });
  }

  /** Full refund — HELD → REFUNDED. Reverses PLATFORM_REVENUE when artist-fault
   *  (business-rules §8.5). Emits escrow.refunded. */
  async refund(holdId: string, opts: RefundOptions): Promise<EscrowHold> {
    return this.applyTransition({
      holdId,
      action: 'REFUND',
      ctx: opts,
      work: async (tx, hold, target) => {
        const refundCents = hold.amountCents;
        const refundedAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: { state: target, refundedAt },
        });
        const event = await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.REFUNDED,
            amountCents: refundCents,
            actorId: opts.actorId ?? null,
            note: opts.note ?? opts.reason ?? null,
            refundId: opts.refundId ?? null,
          },
        });
        await this.writeLedger(
          tx,
          updated,
          event,
          this.ledger.buildRefundEntries(hold, refundCents, opts.faultParty, true),
        );
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — escrow.refunded.json.
          type: PaymentsEventType.ESCROW_REFUNDED,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            clientId: hold.clientId,
            refundCents: Number(refundCents),
            currency: hold.currency,
            refundedAt: refundedAt.toISOString(),
            faultParty: opts.faultParty,
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
      },
    });
  }

  /**
   * Partial refund — HELD or PARTIALLY_REFUNDED → PARTIALLY_REFUNDED. Tracks
   * running total on the hold. Fee is never reversed on partials per
   * business-rules §8.5. Emits escrow.partially_refunded.
   */
  async partialRefund(
    holdId: string,
    refundCents: bigint,
    opts: RefundOptions,
  ): Promise<EscrowHold> {
    if (refundCents <= 0n) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Partial refund amount must be positive.',
      });
    }
    return this.applyTransition({
      holdId,
      action: 'PARTIAL_REFUND',
      ctx: opts,
      work: async (tx, hold, target) => {
        const running = hold.partiallyRefundedAmountCents + refundCents;
        if (running > hold.amountCents) {
          throw new AppException(ErrorCode.REFUND_EXCEEDS_CAPTURE, {
            detail: `Cumulative refund ${running} would exceed held amount ${hold.amountCents}.`,
          });
        }
        const refundedAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: {
            state: target,
            partiallyRefundedAmountCents: running,
            // Mark refundedAt the first time we partial-refund so audit/admin
            // views show "first refunded at". Later partials don't overwrite.
            refundedAt: hold.refundedAt ?? refundedAt,
          },
        });
        const event = await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.PARTIALLY_REFUNDED,
            amountCents: refundCents,
            actorId: opts.actorId ?? null,
            note: opts.note ?? opts.reason ?? null,
            refundId: opts.refundId ?? null,
          },
        });
        // refundIsFull=false → no PLATFORM_REVENUE reversal on partials.
        await this.writeLedger(
          tx,
          updated,
          event,
          this.ledger.buildRefundEntries(hold, refundCents, opts.faultParty, false),
        );
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — escrow.partially_refunded.json.
          type: PaymentsEventType.ESCROW_PARTIALLY_REFUNDED,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            clientId: hold.clientId,
            refundCents: Number(refundCents),
            runningRefundedCents: Number(running),
            currency: hold.currency,
            refundedAt: refundedAt.toISOString(),
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
      },
    });
  }

  /**
   * FREEZE — any non-terminal state → DISPUTED. Cancels any QUEUED payout for
   * the hold (business-rules §8.1 — dispute window claw-back is structural).
   * Emits escrow.frozen.
   */
  async freeze(holdId: string, opts: FreezeOptions): Promise<EscrowHold> {
    return this.applyTransition({
      holdId,
      action: 'FREEZE',
      ctx: opts,
      work: async (tx, hold, target) => {
        const frozenAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: { state: target, disputedAt: frozenAt },
        });
        await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.FROZEN,
            // amountCents semantically meaningless on FROZEN — record the
            // currently-held amount as the audit value.
            amountCents: hold.amountCents - hold.partiallyRefundedAmountCents,
            actorId: opts.actorId ?? null,
            note: opts.reason,
          },
        });
        // FREEZE produces no ledger entries; the funds stay in ESCROW_LIABILITY.
        // Cancel any queued payouts for this hold (business-rules §8.1).
        await tx.payout.updateMany({
          where: { holdId: hold.id, state: PayoutState.QUEUED },
          data: {
            state: PayoutState.CANCELLED,
            cancelledAt: frozenAt,
            cancellationReason: 'ESCROW_FROZEN',
          },
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — escrow.frozen.json.
          type: PaymentsEventType.ESCROW_FROZEN,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            reason: opts.reason,
            frozenAt: frozenAt.toISOString(),
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
        void updated;
      },
    });
  }

  /** DISPUTED → RELEASED. Pays the artist the held amount. Emits escrow.released. */
  async resolveRelease(holdId: string, opts: ResolveOptions = {}): Promise<EscrowHold> {
    return this.applyTransition({
      holdId,
      action: 'RESOLVE_RELEASE',
      ctx: opts,
      work: async (tx, hold, target) => {
        const amount = hold.amountCents - hold.partiallyRefundedAmountCents;
        const releasedAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: { state: target, releasedAt },
        });
        const event = await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.RESOLVED_RELEASE,
            amountCents: amount,
            actorId: opts.actorId ?? null,
            note: opts.resolutionNotes ?? opts.note ?? null,
          },
        });
        await this.writeLedger(
          tx,
          updated,
          event,
          this.ledger.buildReleaseEntriesForAmount(amount),
        );
        await this.queuePayout(tx, updated, amount, releasedAt);
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — escrow.released.json.
          type: PaymentsEventType.ESCROW_RELEASED,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            artistId: hold.artistId,
            amountCents: Number(amount),
            currency: hold.currency,
            releasedAt: releasedAt.toISOString(),
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
      },
    });
  }

  /** DISPUTED → REFUNDED. Refunds the full held amount to the client; treats
   *  the resolution as ARTIST-fault for fee handling (admin chose to refund
   *  the client, so the fee is reversed too). */
  async resolveRefund(holdId: string, opts: ResolveOptions = {}): Promise<EscrowHold> {
    return this.applyTransition({
      holdId,
      action: 'RESOLVE_REFUND',
      ctx: opts,
      work: async (tx, hold, target) => {
        const refundCents = hold.amountCents - hold.partiallyRefundedAmountCents;
        const refundedAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: { state: target, refundedAt },
        });
        const event = await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.RESOLVED_REFUND,
            amountCents: refundCents,
            actorId: opts.actorId ?? null,
            note: opts.resolutionNotes ?? opts.note ?? null,
          },
        });
        await this.writeLedger(
          tx,
          updated,
          event,
          this.ledger.buildRefundEntries(hold, refundCents, 'ARTIST', true),
        );
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — escrow.refunded.json.
          type: PaymentsEventType.ESCROW_REFUNDED,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            clientId: hold.clientId,
            refundCents: Number(refundCents),
            currency: hold.currency,
            refundedAt: refundedAt.toISOString(),
            faultParty: 'ARTIST',
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
      },
    });
  }

  /**
   * DISPUTED → REFUNDED, but the held amount is split:
   *   artistCents → ARTIST_PAYABLE (queued payout, same as release)
   *   clientCents → REFUNDS_ISSUED
   *
   * Convention (PAY-003): one escrow_events row of type RESOLVED_REFUND with
   * a 3-entry ledger event (ESCROW_LIABILITY debit, ARTIST_PAYABLE credit,
   * REFUNDS_ISSUED credit) AND a payouts row for the artist portion. We emit
   * a SINGLE escrow.refunded outbox row with faultParty='SPLIT' + both split
   * amounts in the payload — see report. Rationale: the resolution is one
   * dispute outcome from the subscriber's perspective, so one event keeps
   * downstream consumers (notifications, analytics) ordered.
   */
  async resolveSplit(
    holdId: string,
    artistCents: bigint,
    clientCents: bigint,
    opts: ResolveOptions = {},
  ): Promise<EscrowHold> {
    if (artistCents < 0n || clientCents < 0n) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Split amounts must be non-negative.',
      });
    }

    return this.applyTransition({
      holdId,
      action: 'RESOLVE_SPLIT',
      ctx: opts,
      work: async (tx, hold, target) => {
        const heldAmount = hold.amountCents - hold.partiallyRefundedAmountCents;
        if (artistCents + clientCents !== heldAmount) {
          throw new AppException(ErrorCode.BUSINESS_RULE_VIOLATION, {
            detail: `artistCents + clientCents (${artistCents + clientCents}) must equal the held amount ${heldAmount}.`,
          });
        }

        const resolvedAt = new Date();
        const updated = await tx.escrowHold.update({
          where: { id: hold.id },
          data: {
            state: target,
            // Terminal as REFUNDED but we ALSO set releasedAt so audit reads
            // see the artist portion has moved out of escrow.
            refundedAt: resolvedAt,
            releasedAt: artistCents > 0n ? resolvedAt : null,
          },
        });
        const event = await tx.escrowEvent.create({
          data: {
            holdId: hold.id,
            type: EscrowEventType.RESOLVED_REFUND,
            amountCents: clientCents,
            actorId: opts.actorId ?? null,
            note: opts.resolutionNotes ?? opts.note ?? null,
          },
        });
        // Split ledger: DEBIT ESCROW_LIABILITY held, CREDIT ARTIST_PAYABLE +
        // REFUNDS_ISSUED. Fee non-refundable per §8.5 (the held amount is
        // already net of the fee).
        await this.writeLedger(
          tx,
          updated,
          event,
          this.ledger.buildSplitEntries(
            { amountCents: heldAmount, platformFeeCents: hold.platformFeeCents },
            artistCents,
            clientCents,
          ),
        );
        if (artistCents > 0n) {
          await this.queuePayout(tx, updated, artistCents, resolvedAt);
        }
        await this.outbox.enqueue(tx, {
          aggregateType: 'EscrowHold',
          aggregateId: hold.id,
          // TODO(orchestrator): event schema missing — escrow.refunded.json
          // (with faultParty=SPLIT + splitArtistCents/splitClientCents fields
          // beyond the strict refund payload).
          type: PaymentsEventType.ESCROW_REFUNDED,
          subject: `escrow-holds/${hold.id}`,
          data: {
            holdId: hold.id,
            bookingId: hold.bookingId,
            clientId: hold.clientId,
            artistId: hold.artistId,
            refundCents: Number(clientCents),
            splitArtistCents: Number(artistCents),
            splitClientCents: Number(clientCents),
            currency: hold.currency,
            refundedAt: resolvedAt.toISOString(),
            faultParty: 'SPLIT',
          },
          traceparent: opts.traceparent,
          tracestate: opts.tracestate,
        });
      },
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * One canonical entry point for every state mutation. Pattern (documented):
   *
   *   $transaction(Serializable):
   *     1. SELECT … FOR UPDATE on escrow_holds.id (pin the row).
   *     2. Run state-machine check.
   *     3. Run caller's `work(tx, hold, target)` — DB writes + outbox enqueue.
   *
   * Choice: we use `tx.$queryRaw` for the FOR UPDATE rather than
   * findUniqueOrThrow because Prisma 5 has no row-lock primitive and the
   * Serializable isolation level alone is not enough to prevent two parallel
   * admin clicks from each *reading* HELD before either commits. The raw
   * SELECT pins the row in the same transaction so the second click then
   * reads the post-update state and the machine throws ILLEGAL_TRANSITION.
   */
  private async applyTransition(args: ApplyTransitionArgs): Promise<EscrowHold> {
    return this.prisma.$transaction(
      async (tx) => {
        // 1. Row lock. The `… FOR UPDATE` only takes effect inside an open
        //    transaction — Prisma's $transaction guarantees that.
        const rows = await tx.$queryRaw<EscrowHold[]>`
          SELECT * FROM "escrow_holds"
          WHERE "id" = ${args.holdId}::uuid
          FOR UPDATE
        `;
        const locked = rows[0];
        if (!locked) throw new AppException(ErrorCode.NOT_FOUND);
        // Prisma returns snake_case rows for $queryRaw — re-read via the typed
        // findUniqueOrThrow now that the row is pinned, so downstream code
        // sees camelCase + BigInt fields.
        const hold = await tx.escrowHold.findUniqueOrThrow({ where: { id: args.holdId } });

        // 2. Transition check. Throws ESCROW_ILLEGAL_TRANSITION / ESCROW_FROZEN.
        if (!canTransition(hold.state, args.action)) {
          // nextState() throws the right exception for us.
          nextState(hold.state, args.action);
        }
        const target = nextState(hold.state, args.action);

        // 3. Side-effects.
        await args.work(tx, hold, target);

        // 4. Return the post-update row.
        return tx.escrowHold.findUniqueOrThrow({ where: { id: args.holdId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Write the per-event ledger entries after balance-checking them. Throws
   * LEDGER_IMBALANCE on failure — this should never reach the client; it's an
   * internal safety net. We log at `error` so an alert fires before the
   * caller's transaction is rolled back.
   */
  private async writeLedger(
    tx: Prisma.TransactionClient,
    hold: EscrowHold,
    event: EscrowEvent,
    entries: LedgerEntryInput[],
  ): Promise<void> {
    try {
      this.ledger.assertBalanced(entries);
    } catch (err) {
      this.logger.error(`LEDGER_IMBALANCE on hold=${hold.id} event=${event.id} type=${event.type}`);
      throw err;
    }
    if (entries.length === 0) return;
    await tx.ledgerEntry.createMany({
      data: entries.map((e) => ({
        holdId: hold.id,
        eventId: event.id,
        account: e.account,
        direction: e.direction,
        amountCents: e.amountCents,
        currency: hold.currency,
      })),
    });
  }

  /**
   * Queue an artist payout row (business-rules §8.1). PAY-005's dispatcher
   * cron only picks up QUEUED rows where dispatch_after <= now.
   */
  private async queuePayout(
    tx: Prisma.TransactionClient,
    hold: EscrowHold,
    amountCents: bigint,
    releasedAt: Date,
  ): Promise<void> {
    if (amountCents <= 0n) return;
    const dispatchAfter = new Date(
      releasedAt.getTime() + this.config.business.disputeWindowDays * 24 * 60 * 60 * 1000,
    );
    await tx.payout.create({
      data: {
        artistId: hold.artistId,
        holdId: hold.id,
        amountCents,
        currency: hold.currency,
        state: PayoutState.QUEUED,
        dispatchAfter,
      },
    });
  }
}
