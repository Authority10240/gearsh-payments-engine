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
 * PAY-006 — concrete DisputeEventsHandler. Consumer name unchanged from
 * PAY-001 so processed_events dedup carries across the rollout.
 *
 * Inbound: disputes.resolved (contracts/events/schemas/disputes.resolved.json)
 * Branches on `resolution`:
 *   RELEASE_TO_ARTIST → EscrowService.resolveRelease   (DISPUTED → RELEASED, payout queued)
 *   REFUND_TO_CLIENT  → RefundsService.issueRefund(full, faultParty=ARTIST)
 *                        — the §8.5 fee reversal happens here, exactly like an
 *                          admin-initiated artist-fault refund.
 *   SPLIT             → EscrowService.resolveSplit     (artist + client split,
 *                        ledger-only — no PayFast Refund API call per
 *                        EscrowService convention)
 *
 * Hold lookup: the disputes.resolved schema carries escrowHoldId directly,
 * so we use it as the source of truth. We still reconcile against the
 * bookingId → hold mapping; on drift we log + use the DB row (matches the
 * booking-events handler convention).
 *
 * Idempotency: processed_events dedup at consumer boundary + catch-and-ack on
 * ESCROW_ILLEGAL_TRANSITION / ESCROW_FROZEN (already resolved). PAYFAST_
 * UPSTREAM_FAILURE on REFUND_TO_CLIENT is re-thrown so the subscriber NACKs
 * and Pub/Sub redelivers.
 */
@Injectable()
export class DisputeEventsHandler implements EventHandler {
  private readonly logger = new Logger(DisputeEventsHandler.name);
  /** Stable consumer name — unchanged since PAY-001. */
  readonly consumerName = 'payments-escrow-dispute';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly escrow: EscrowService,
    private readonly refunds: RefundsService,
  ) {}

  handles(eventType: string): boolean {
    return eventType === 'disputes.resolved';
  }

  async handle(event: CloudEvent): Promise<void> {
    validateEventPayload(event);
    const data = event.data as Record<string, unknown>;
    const bookingId = data.bookingId as string;
    const payloadHoldId = data.escrowHoldId as string;
    const resolution = data.resolution as 'RELEASE_TO_ARTIST' | 'REFUND_TO_CLIENT' | 'SPLIT';
    const resolvedBy = (data.resolvedBy as string) ?? this.config.systemUserId;
    const resolutionNotes = (data.resolutionNotes as string | undefined) ?? null;

    const hold = await this.resolveHold(event, bookingId, payloadHoldId);
    if (!hold) return;

    if (hold.state === EscrowState.RELEASED || hold.state === EscrowState.REFUNDED) {
      // Already resolved (by an admin race or a prior subscriber run). Ack.
      this.logHandled(event, hold, 'already-resolved', { holdState: hold.state });
      return;
    }

    try {
      switch (resolution) {
        case 'RELEASE_TO_ARTIST': {
          await this.escrow.resolveRelease(hold.id, {
            actorId: resolvedBy,
            resolutionNotes,
          });
          this.logHandled(event, hold, 'resolved-release');
          return;
        }
        case 'REFUND_TO_CLIENT': {
          // Artist-fault refund → §8.5 PLATFORM_REVENUE reversal happens
          // inside RefundsService → EscrowService.refund.
          await this.refunds.issueRefund({
            holdId: hold.id,
            full: true,
            faultParty: 'ARTIST',
            reason: 'dispute-resolved-refund',
            actorId: resolvedBy,
          });
          this.logHandled(event, hold, 'resolved-refund');
          return;
        }
        case 'SPLIT': {
          const splitArtistCents = BigInt(data.splitArtistCents as number);
          const splitClientCents = BigInt(data.splitClientCents as number);
          await this.escrow.resolveSplit(hold.id, splitArtistCents, splitClientCents, {
            actorId: resolvedBy,
            resolutionNotes,
          });
          this.logHandled(event, hold, 'resolved-split', {
            splitArtistCents: Number(splitArtistCents),
            splitClientCents: Number(splitClientCents),
          });
          return;
        }
      }
    } catch (err) {
      if (isExpectedTerminalTransition(err)) {
        this.logHandled(event, hold, 'already-resolved', {
          code: (err as AppException).code,
          resolution,
        });
        return;
      }
      // PAYFAST_UPSTREAM_FAILURE on REFUND_TO_CLIENT bubbles up → subscriber
      // NACKs → Pub/Sub redelivers → DLT.
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Source of truth = payload escrowHoldId (the disputes.resolved schema makes
   * it REQUIRED, unlike bookings.cancelled). Reconcile against the DB lookup
   * by bookingId and log on drift.
   */
  private async resolveHold(
    event: CloudEvent,
    bookingId: string,
    payloadHoldId: string,
  ): Promise<EscrowHold | null> {
    const hold = await this.prisma.escrowHold.findUnique({ where: { id: payloadHoldId } });
    if (hold) {
      if (hold.bookingId !== bookingId) {
        this.logger.warn(
          `[PAY-006] ${event.type} eventId=${event.id} escrowHoldId=${payloadHoldId} -> bookingId ${hold.bookingId} but payload bookingId=${bookingId} (drift)`,
        );
      }
      return hold;
    }
    // Fall back to bookingId lookup (defensive — escrowHoldId might be stale).
    const fallback = await this.prisma.escrowHold.findUnique({ where: { bookingId } });
    if (!fallback) {
      this.logger.log(
        `[PAY-006] ${event.type} eventId=${event.id} bookingId=${bookingId} escrowHoldId=${payloadHoldId} — no escrow hold; ack`,
      );
      return null;
    }
    this.logger.warn(
      `[PAY-006] ${event.type} eventId=${event.id} escrowHoldId payload=${payloadHoldId} not found; using bookingId fallback ${fallback.id}`,
    );
    return fallback;
  }

  /** Structured single-line log per handled event — eventId, type, bookingId,
   *  holdId, action, plus any extra context. Read by PAY-007 reconciler. */
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
 *  a terminal / resolved state. */
function isExpectedTerminalTransition(err: unknown): boolean {
  if (!(err instanceof AppException)) return false;
  return (
    err.code === ErrorCode.ESCROW_ILLEGAL_TRANSITION ||
    err.code === ErrorCode.ESCROW_FROZEN ||
    err.code === ErrorCode.ILLEGAL_TRANSITION
  );
}
