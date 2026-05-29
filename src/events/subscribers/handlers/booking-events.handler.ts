import { Inject, Injectable, Logger } from '@nestjs/common';
import { EscrowState, type EscrowHold } from '@prisma/client';
import { APP_CONFIG } from '../../../config/app-config.token';
import type { AppConfig } from '../../../config/configuration';
import { AppException } from '../../../common/problem/app-exception';
import { ErrorCode } from '../../../common/problem/error-codes';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { EscrowService } from '../../../modules/escrow/escrow.service';
import { RefundsService } from '../../../modules/refunds/refunds.service';
import type { CloudEvent } from '../../cloud-event';
import type { EventHandler } from '../event-handler';
import { validateEventPayload } from '../payload-schemas';

/**
 * PAY-006 — concrete BookingEventsHandler that closes the loop with the Data
 * Engine. Consumer name unchanged from PAY-001 so the processed_events dedup
 * surface stays continuous across the rollout.
 *
 * Inbound types (matches contracts/events/schemas/*.json):
 *   - bookings.completed → EscrowService.release(holdId)
 *   - bookings.cancelled → branch on refundPolicy + actorRole:
 *       FULL_REFUND   + ARTIST → RefundsService.issueRefund(full, ARTIST)
 *       FULL_REFUND   + CLIENT → RefundsService.issueRefund(full, CLIENT)
 *       PARTIAL_REFUND        → RefundsService.issueRefund(partial, CLIENT)
 *       NO_REFUND             → EscrowService.release(holdId)
 *   - bookings.disputed  → EscrowService.freeze(holdId, 'bookings.disputed')
 *
 * Idempotency: processed_events dedups at the consumer boundary. As belt-and-
 * braces every handler also catches ESCROW_ILLEGAL_TRANSITION / ESCROW_FROZEN
 * (state already at target — e.g. a manual admin release ran first) and acks.
 * PAYFAST_UPSTREAM_FAILURE from RefundsService is re-thrown so the subscriber
 * NACKs → Pub/Sub redelivers → DLT after max attempts (events/README §5).
 *
 * The hold is looked up by booking_id (PAY-002 wrote escrow_holds.booking_id
 * on ITN); when the event payload also carries escrowHoldId we cross-check
 * the two and log on mismatch (don't fail — the event id is authoritative).
 */
@Injectable()
export class BookingEventsHandler implements EventHandler {
  private readonly logger = new Logger(BookingEventsHandler.name);
  /** Stable consumer name — unchanged since PAY-001. */
  readonly consumerName = 'payments-escrow-booking';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly escrow: EscrowService,
    private readonly refunds: RefundsService,
  ) {}

  handles(eventType: string): boolean {
    return (
      eventType === 'bookings.completed' ||
      eventType === 'bookings.cancelled' ||
      eventType === 'bookings.disputed'
    );
  }

  async handle(event: CloudEvent): Promise<void> {
    // Validate inbound payload up-front — a missing required field or invalid
    // enum throws EventPayloadValidationError which the subscriber turns into
    // a NACK → DLT (events/README §5).
    validateEventPayload(event);
    const data = event.data as Record<string, unknown>;
    const bookingId = data.bookingId as string;
    const payloadHoldId = (data.escrowHoldId ?? null) as string | null;

    switch (event.type) {
      case 'bookings.completed':
        await this.onCompleted(event, bookingId, payloadHoldId);
        return;
      case 'bookings.cancelled':
        await this.onCancelled(event, bookingId, payloadHoldId, data);
        return;
      case 'bookings.disputed':
        await this.onDisputed(event, bookingId, payloadHoldId);
        return;
      default:
        // handles() guards this — defensive.
        this.logger.warn(`[PAY-006] unexpected event type ${event.type}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // bookings.completed → escrow.release
  // ────────────────────────────────────────────────────────────────────────

  private async onCompleted(
    event: CloudEvent,
    bookingId: string,
    payloadHoldId: string | null,
  ): Promise<void> {
    const hold = await this.resolveHold(event, bookingId, payloadHoldId);
    if (!hold) return;

    if (hold.state !== EscrowState.HELD && hold.state !== EscrowState.PARTIALLY_REFUNDED) {
      // Already RELEASED (manual admin release ran first, or a prior subscriber
      // run completed), or REFUNDED/DISPUTED — log + ack. The state machine
      // would throw on a duplicate release; we short-circuit so processed_events
      // alone is enough for happy-path dedup.
      this.logHandled(event, hold, 'noop-state-not-eligible', { holdState: hold.state });
      return;
    }

    try {
      await this.escrow.release(hold.id, {
        actorId: null,
        note: 'auto-release: bookings.completed',
      });
      this.logHandled(event, hold, 'released');
    } catch (err) {
      if (isExpectedTerminalTransition(err)) {
        // Treat already-RELEASED / already-terminal as success — processed_events
        // dedup should normally catch this, but a different consumer name (or
        // an admin race) can still get here.
        this.logHandled(event, hold, 'already-released', {
          code: (err as AppException).code,
        });
        return;
      }
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // bookings.cancelled → refund-or-release per refundPolicy + actorRole
  // ────────────────────────────────────────────────────────────────────────

  private async onCancelled(
    event: CloudEvent,
    bookingId: string,
    payloadHoldId: string | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    const hold = await this.resolveHold(event, bookingId, payloadHoldId);
    if (!hold) return;

    const refundPolicy = data.refundPolicy as 'FULL_REFUND' | 'PARTIAL_REFUND' | 'NO_REFUND';
    const actorRole = data.actorRole as 'CLIENT' | 'ARTIST' | 'ADMIN' | 'SYSTEM';

    // Decision tree per business-rules §2 (refund tiers) + §8.5 (fee handling).
    // The lead-time tier is already encoded by the Data Engine into refundPolicy
    // + partialRefundCents — we faithfully apply it here.
    try {
      switch (refundPolicy) {
        case 'FULL_REFUND': {
          // ARTIST-fault FULL refund triggers the §8.5 PLATFORM_REVENUE
          // reversal; CLIENT cancel keeps the fee with the platform.
          const faultParty = actorRole === 'ARTIST' ? 'ARTIST' : 'CLIENT';
          const reason =
            actorRole === 'ARTIST'
              ? 'booking-cancelled-artist-fault'
              : 'booking-cancelled-client-tiered';
          await this.refunds.issueRefund({
            holdId: hold.id,
            full: true,
            faultParty,
            reason,
            actorId: this.config.systemUserId,
          });
          this.logHandled(event, hold, `refund-full-${faultParty.toLowerCase()}`);
          return;
        }
        case 'PARTIAL_REFUND': {
          const refundCents = BigInt(data.partialRefundCents as number);
          await this.refunds.issueRefund({
            holdId: hold.id,
            refundCents,
            faultParty: 'CLIENT',
            reason: 'booking-cancelled-partial',
            actorId: this.config.systemUserId,
          });
          this.logHandled(event, hold, 'refund-partial', { refundCents: Number(refundCents) });
          return;
        }
        case 'NO_REFUND': {
          // Per business-rules §8.5 a NO_REFUND policy on a CLIENT cancellation
          // means the artist is paid in full (the client cancelled too late
          // and forfeits). This is the same money movement as a normal
          // bookings.completed RELEASE — funds + queued payout to artist.
          await this.escrow.release(hold.id, {
            actorId: null,
            note: 'no-refund cancellation: artist keeps full payment',
          });
          this.logHandled(event, hold, 'no-refund-released');
          return;
        }
      }
    } catch (err) {
      if (isExpectedTerminalTransition(err)) {
        this.logHandled(event, hold, 'already-terminal', {
          code: (err as AppException).code,
          refundPolicy,
        });
        return;
      }
      // PAYFAST_UPSTREAM_FAILURE → re-throw so the subscriber NACKs and
      // Pub/Sub redelivers (events/README §5). Eventually DLT.
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // bookings.disputed → escrow.freeze
  // ────────────────────────────────────────────────────────────────────────

  private async onDisputed(
    event: CloudEvent,
    bookingId: string,
    payloadHoldId: string | null,
  ): Promise<void> {
    const hold = await this.resolveHold(event, bookingId, payloadHoldId);
    if (!hold) return;

    if (hold.state === EscrowState.DISPUTED) {
      this.logHandled(event, hold, 'already-disputed');
      return;
    }
    if (hold.state === EscrowState.RELEASED || hold.state === EscrowState.REFUNDED) {
      // Race with the dispatcher / a prior release — dispute opens on a
      // booking whose funds have already been moved. We can't freeze; log +
      // ack so the event isn't reprocessed. The Data Engine / admin tools
      // surface this as a stuck dispute.
      this.logger.warn(
        `[PAY-006] dispute opened on hold ${hold.id} in terminal state ${hold.state}; cannot freeze`,
      );
      this.logHandled(event, hold, 'noop-terminal-state', { holdState: hold.state });
      return;
    }
    try {
      await this.escrow.freeze(hold.id, {
        reason: 'bookings.disputed',
        actorId: null,
      });
      this.logHandled(event, hold, 'frozen');
    } catch (err) {
      if (isExpectedTerminalTransition(err)) {
        this.logHandled(event, hold, 'already-disputed', {
          code: (err as AppException).code,
        });
        return;
      }
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Look up the hold by booking_id (PAY-002 wrote escrow_holds.booking_id on
   * ITN). If the payload also carries escrowHoldId we cross-check the two;
   * the booking-id lookup is the authoritative source of truth because:
   *   (a) the ITN webhook is what created the hold in this DB,
   *   (b) the Data Engine's escrowHoldId is denormalised from its own copy.
   *
   * Returns null + logs+ acks when no hold exists (booking cancelled pre-
   * payment, or duplicate event for a never-paid booking — events/README §6).
   */
  private async resolveHold(
    event: CloudEvent,
    bookingId: string,
    payloadHoldId: string | null,
  ): Promise<EscrowHold | null> {
    const hold = await this.prisma.escrowHold.findUnique({ where: { bookingId } });
    if (!hold) {
      this.logger.log(
        `[PAY-006] ${event.type} eventId=${event.id} bookingId=${bookingId} — no escrow hold; ack (cancelled pre-payment or never paid)`,
      );
      return null;
    }
    if (payloadHoldId && payloadHoldId !== hold.id) {
      // Don't fail — the bookingId → hold mapping is authoritative. Log the
      // drift so reconciliation (PAY-007) can investigate.
      this.logger.warn(
        `[PAY-006] ${event.type} eventId=${event.id} escrowHoldId payload=${payloadHoldId} but DB lookup by bookingId=${bookingId} returned ${hold.id} — using DB value`,
      );
    }
    return hold;
  }

  /** Structured single-line log per handled event — eventId, type, bookingId,
   *  holdId, action, plus any extra context. Read by the PAY-007 reconciler. */
  private logHandled(
    event: CloudEvent,
    hold: EscrowHold,
    action: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log(
      JSON.stringify({
        msg: 'subscriber.handled',
        eventId: event.id,
        eventType: event.type,
        bookingId: hold.bookingId,
        holdId: hold.id,
        action,
        ...extra,
      }),
    );
  }
}

/** True if the error is the expected idempotent transition guard — already at
 *  terminal state. Both escrow-state machine codes count. */
function isExpectedTerminalTransition(err: unknown): boolean {
  if (!(err instanceof AppException)) return false;
  return (
    err.code === ErrorCode.ESCROW_ILLEGAL_TRANSITION ||
    err.code === ErrorCode.ESCROW_FROZEN ||
    err.code === ErrorCode.ILLEGAL_TRANSITION
  );
}
