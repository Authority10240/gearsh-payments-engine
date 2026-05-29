import { EscrowState } from '@prisma/client';
import { AppException } from '../../../common/problem/app-exception';
import { ErrorCode } from '../../../common/problem/error-codes';
import type { CloudEvent } from '../../cloud-event';
import { DisputeEventsHandler } from './dispute-events.handler';

/**
 * Unit coverage for DisputeEventsHandler (PAY-006).
 *
 * Scope:
 *   - resolution → service-call shape:
 *       RELEASE_TO_ARTIST → EscrowService.resolveRelease.
 *       REFUND_TO_CLIENT  → RefundsService.issueRefund(full, ARTIST).
 *       SPLIT             → EscrowService.resolveSplit(artist, client).
 *   - Hold resolution: payload escrowHoldId preferred, falls back to bookingId.
 *   - Hold-not-found → log + ack (no service calls).
 *   - Already-resolved (RELEASED/REFUNDED) state → noop ack.
 *   - ESCROW_ILLEGAL_TRANSITION on resolve → ack.
 *   - PAYFAST_UPSTREAM_FAILURE re-thrown.
 *   - Payload validation: missing resolution field, SPLIT without splits.
 */
describe('DisputeEventsHandler (unit)', () => {
  const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
  const HOLD_ID = '01910000-0000-7000-8000-000000000001';
  const BOOKING_ID = '01910000-0000-7000-8000-000000000010';
  const DISPUTE_ID = '01910000-0000-7000-8000-000000000060';
  const RESOLVED_BY = '01910000-0000-7000-8000-000000000099';

  const baseHold: {
    id: string;
    bookingId: string;
    paymentIntentId: string;
    clientId: string;
    artistId: string;
    amountCents: bigint;
    platformFeeCents: bigint;
    currency: 'ZAR';
    state: EscrowState;
    partiallyRefundedAmountCents: bigint;
    heldAt: Date;
    releasedAt: Date | null;
    refundedAt: Date | null;
    disputedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } = {
    id: HOLD_ID,
    bookingId: BOOKING_ID,
    paymentIntentId: '01910000-0000-7000-8000-000000000002',
    clientId: '01910000-0000-7000-8000-000000000020',
    artistId: '01910000-0000-7000-8000-000000000030',
    amountCents: 200_000n,
    platformFeeCents: 25_200n,
    currency: 'ZAR',
    state: EscrowState.DISPUTED,
    partiallyRefundedAmountCents: 0n,
    heldAt: new Date(),
    releasedAt: null,
    refundedAt: null,
    disputedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeHandler(opts?: {
    holdById?: typeof baseHold | null;
    holdByBookingId?: typeof baseHold | null;
  }): {
    handler: DisputeEventsHandler;
    findUniqueById: jest.Mock;
    findUniqueByBookingId: jest.Mock;
    resolveRelease: jest.Mock;
    resolveSplit: jest.Mock;
    issueRefund: jest.Mock;
  } {
    const holdById = opts?.holdById === undefined ? baseHold : opts.holdById;
    const holdByBookingId = opts?.holdByBookingId === undefined ? baseHold : opts.holdByBookingId;
    const findUniqueById = jest.fn();
    const findUniqueByBookingId = jest.fn();
    const findUnique = jest.fn(({ where }: { where: { id?: string; bookingId?: string } }) => {
      if (where.id) {
        findUniqueById(where);
        return Promise.resolve(holdById);
      }
      findUniqueByBookingId(where);
      return Promise.resolve(holdByBookingId);
    });
    const prisma = { escrowHold: { findUnique } } as never;
    const resolveRelease = jest.fn().mockResolvedValue(undefined);
    const resolveSplit = jest.fn().mockResolvedValue(undefined);
    const issueRefund = jest.fn().mockResolvedValue({ id: 'refund-1', state: 'SUCCEEDED' });
    const escrow = { resolveRelease, resolveSplit } as never;
    const refunds = { issueRefund } as never;
    const config = { systemUserId: SYSTEM_USER_ID } as never;
    return {
      handler: new DisputeEventsHandler(config, prisma, escrow, refunds),
      findUniqueById,
      findUniqueByBookingId,
      resolveRelease,
      resolveSplit,
      issueRefund,
    };
  }

  function envelope(data: Record<string, unknown>): CloudEvent {
    return {
      specversion: '1.0',
      id: 'evt-dispute-resolved-1',
      type: 'disputes.resolved',
      source: 'gearsh-data-engine',
      subject: `disputes/${DISPUTE_ID}`,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      dataschema: 'https://contracts.thegearsh.app/events/disputes.resolved/1.0.0',
      data,
      traceparent: '00-0000-0000-00',
      tracestate: '',
    } as CloudEvent;
  }

  // ── claims ──────────────────────────────────────────────────────────────

  it('handles() claims only disputes.resolved', () => {
    const { handler } = makeHandler();
    expect(handler.handles('disputes.resolved')).toBe(true);
    expect(handler.handles('bookings.completed')).toBe(false);
  });

  // ── resolution branching ────────────────────────────────────────────────

  it('RELEASE_TO_ARTIST → EscrowService.resolveRelease(holdId, {actorId, notes})', async () => {
    const { handler, resolveRelease } = makeHandler();
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: HOLD_ID,
        resolution: 'RELEASE_TO_ARTIST',
        resolvedBy: RESOLVED_BY,
        resolutionNotes: 'evidence sufficient',
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(resolveRelease).toHaveBeenCalledWith(HOLD_ID, {
      actorId: RESOLVED_BY,
      resolutionNotes: 'evidence sufficient',
    });
  });

  it('REFUND_TO_CLIENT → RefundsService.issueRefund(full, ARTIST-fault)', async () => {
    const { handler, issueRefund } = makeHandler();
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: HOLD_ID,
        resolution: 'REFUND_TO_CLIENT',
        resolvedBy: RESOLVED_BY,
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(issueRefund).toHaveBeenCalledWith({
      holdId: HOLD_ID,
      full: true,
      faultParty: 'ARTIST',
      reason: 'dispute-resolved-refund',
      actorId: RESOLVED_BY,
    });
  });

  it('SPLIT → EscrowService.resolveSplit(holdId, artistCents, clientCents, {actorId, notes})', async () => {
    const { handler, resolveSplit } = makeHandler();
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: HOLD_ID,
        resolution: 'SPLIT',
        splitArtistCents: 60_000,
        splitClientCents: 140_000,
        resolvedBy: RESOLVED_BY,
        resolutionNotes: 'evidence on both sides',
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(resolveSplit).toHaveBeenCalledWith(HOLD_ID, 60_000n, 140_000n, {
      actorId: RESOLVED_BY,
      resolutionNotes: 'evidence on both sides',
    });
  });

  // ── hold resolution ────────────────────────────────────────────────────

  it('falls back to bookingId lookup when escrowHoldId not found', async () => {
    const { handler, findUniqueByBookingId, resolveRelease } = makeHandler({
      holdById: null,
      holdByBookingId: baseHold,
    });
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: 'stale-id',
        resolution: 'RELEASE_TO_ARTIST',
        resolvedBy: RESOLVED_BY,
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(findUniqueByBookingId).toHaveBeenCalled();
    expect(resolveRelease).toHaveBeenCalledTimes(1);
  });

  it('no hold by either lookup → log + ack, no service call', async () => {
    const { handler, resolveRelease, issueRefund, resolveSplit } = makeHandler({
      holdById: null,
      holdByBookingId: null,
    });
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: HOLD_ID,
        resolution: 'RELEASE_TO_ARTIST',
        resolvedBy: RESOLVED_BY,
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(resolveRelease).not.toHaveBeenCalled();
    expect(issueRefund).not.toHaveBeenCalled();
    expect(resolveSplit).not.toHaveBeenCalled();
  });

  // ── idempotency ────────────────────────────────────────────────────────

  it('hold already RELEASED → noop ack (no resolveRelease call)', async () => {
    const { handler, resolveRelease } = makeHandler({
      holdById: { ...baseHold, state: EscrowState.RELEASED },
    });
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: HOLD_ID,
        resolution: 'RELEASE_TO_ARTIST',
        resolvedBy: RESOLVED_BY,
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  it('hold already REFUNDED → noop ack on SPLIT resolution', async () => {
    const { handler, resolveSplit } = makeHandler({
      holdById: { ...baseHold, state: EscrowState.REFUNDED },
    });
    await handler.handle(
      envelope({
        disputeId: DISPUTE_ID,
        bookingId: BOOKING_ID,
        escrowHoldId: HOLD_ID,
        resolution: 'SPLIT',
        splitArtistCents: 60_000,
        splitClientCents: 140_000,
        resolvedBy: RESOLVED_BY,
        resolvedAt: '2026-05-10T10:00:00.000Z',
      }),
    );
    expect(resolveSplit).not.toHaveBeenCalled();
  });

  it('ESCROW_ILLEGAL_TRANSITION on resolveRelease → ack', async () => {
    const { handler, resolveRelease } = makeHandler();
    resolveRelease.mockRejectedValueOnce(new AppException(ErrorCode.ESCROW_ILLEGAL_TRANSITION));
    await expect(
      handler.handle(
        envelope({
          disputeId: DISPUTE_ID,
          bookingId: BOOKING_ID,
          escrowHoldId: HOLD_ID,
          resolution: 'RELEASE_TO_ARTIST',
          resolvedBy: RESOLVED_BY,
          resolvedAt: '2026-05-10T10:00:00.000Z',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('PAYFAST_UPSTREAM_FAILURE on REFUND_TO_CLIENT → re-thrown (NACK)', async () => {
    const { handler, issueRefund } = makeHandler();
    issueRefund.mockRejectedValueOnce(new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE));
    await expect(
      handler.handle(
        envelope({
          disputeId: DISPUTE_ID,
          bookingId: BOOKING_ID,
          escrowHoldId: HOLD_ID,
          resolution: 'REFUND_TO_CLIENT',
          resolvedBy: RESOLVED_BY,
          resolvedAt: '2026-05-10T10:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(AppException);
  });

  // ── payload validation ─────────────────────────────────────────────────

  it('rejects when resolution missing', async () => {
    const { handler } = makeHandler();
    await expect(
      handler.handle(
        envelope({
          disputeId: DISPUTE_ID,
          bookingId: BOOKING_ID,
          escrowHoldId: HOLD_ID,
          resolvedBy: RESOLVED_BY,
          resolvedAt: '2026-05-10T10:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/resolution/);
  });

  it('rejects SPLIT without splitArtistCents / splitClientCents', async () => {
    const { handler } = makeHandler();
    await expect(
      handler.handle(
        envelope({
          disputeId: DISPUTE_ID,
          bookingId: BOOKING_ID,
          escrowHoldId: HOLD_ID,
          resolution: 'SPLIT',
          resolvedBy: RESOLVED_BY,
          resolvedAt: '2026-05-10T10:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/splitArtistCents|splitClientCents/);
  });
});
