import { EscrowState } from '@prisma/client';
import { AppException } from '../../../common/problem/app-exception';
import { ErrorCode } from '../../../common/problem/error-codes';
import type { CloudEvent } from '../../cloud-event';
import { BookingEventsHandler } from './booking-events.handler';

/**
 * Unit coverage for BookingEventsHandler (PAY-006).
 *
 * Scope:
 *   - refundPolicy + actorRole → RefundsService.issueRefund argument shape:
 *       FULL_REFUND+CLIENT, FULL_REFUND+ARTIST, PARTIAL_REFUND, NO_REFUND.
 *   - bookings.completed → EscrowService.release(holdId).
 *   - bookings.disputed → EscrowService.freeze(holdId, ...).
 *   - Hold-not-found → log+ack (no service calls).
 *   - Already-terminal state → no service call; ack.
 *   - Idempotent catch of ESCROW_ILLEGAL_TRANSITION → ack.
 *   - PAYFAST_UPSTREAM_FAILURE re-thrown (subscriber NACKs).
 *
 * Mocking strategy: PrismaService, EscrowService, RefundsService are
 * hand-rolled jest.fn() fakes — the DI graph is built by hand so the
 * test runs without spinning up Nest. AppConfig is a plain object.
 */
describe('BookingEventsHandler (unit)', () => {
  const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
  const HOLD_ID = '01910000-0000-7000-8000-000000000001';
  const BOOKING_ID = '01910000-0000-7000-8000-000000000010';
  const CLIENT_ID = '01910000-0000-7000-8000-000000000020';
  const ARTIST_ID = '01910000-0000-7000-8000-000000000030';

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
    clientId: CLIENT_ID,
    artistId: ARTIST_ID,
    amountCents: 100_000n,
    platformFeeCents: 12_600n,
    currency: 'ZAR',
    state: EscrowState.HELD,
    partiallyRefundedAmountCents: 0n,
    heldAt: new Date(),
    releasedAt: null,
    refundedAt: null,
    disputedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeHandler(holdOverride?: Partial<typeof baseHold>): {
    handler: BookingEventsHandler;
    findUnique: jest.Mock;
    release: jest.Mock;
    freeze: jest.Mock;
    issueRefund: jest.Mock;
  } {
    const hold = holdOverride === null ? null : { ...baseHold, ...holdOverride };
    const findUnique = jest.fn().mockResolvedValue(holdOverride === null ? null : hold);
    const prisma = { escrowHold: { findUnique } } as never;
    const release = jest.fn().mockResolvedValue(undefined);
    const freeze = jest.fn().mockResolvedValue(undefined);
    const issueRefund = jest.fn().mockResolvedValue({ id: 'refund-1', state: 'SUCCEEDED' });
    const escrow = { release, freeze } as never;
    const refunds = { issueRefund } as never;
    const config = { systemUserId: SYSTEM_USER_ID } as never;
    return {
      handler: new BookingEventsHandler(config, prisma, escrow, refunds),
      findUnique,
      release,
      freeze,
      issueRefund,
    };
  }

  function envelope<T extends Record<string, unknown>>(type: string, data: T): CloudEvent {
    return {
      specversion: '1.0',
      id: `evt-${type}-1`,
      type,
      source: 'gearsh-data-engine',
      subject: `bookings/${BOOKING_ID}`,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      dataschema: `https://contracts.thegearsh.app/events/${type}/1.0.0`,
      data,
      traceparent: '00-0000-0000-00',
      tracestate: '',
    } as CloudEvent;
  }

  // ── claims ──────────────────────────────────────────────────────────────

  it('handles() claims the three booking event types and nothing else', () => {
    const { handler } = makeHandler();
    expect(handler.handles('bookings.completed')).toBe(true);
    expect(handler.handles('bookings.cancelled')).toBe(true);
    expect(handler.handles('bookings.disputed')).toBe(true);
    expect(handler.handles('disputes.resolved')).toBe(false);
    expect(handler.handles('payments.succeeded')).toBe(false);
  });

  // ── bookings.completed ─────────────────────────────────────────────────

  it('bookings.completed on a HELD hold → EscrowService.release(holdId)', async () => {
    const { handler, release } = makeHandler();
    await handler.handle(
      envelope('bookings.completed', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        serviceId: '01910000-0000-7000-8000-000000000040',
        escrowHoldId: HOLD_ID,
        startAt: '2026-05-01T10:00:00.000Z',
        endAt: '2026-05-01T11:00:00.000Z',
        totalCents: 112_600,
        currency: 'ZAR',
        completedAt: '2026-05-01T13:00:00.000Z',
        completionReason: 'AUTO_COMPLETE',
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(HOLD_ID, {
      actorId: null,
      note: 'auto-release: bookings.completed',
    });
  });

  it('bookings.completed on an already-RELEASED hold → noop (no release call)', async () => {
    const { handler, release } = makeHandler({ state: EscrowState.RELEASED });
    await handler.handle(
      envelope('bookings.completed', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        serviceId: '01910000-0000-7000-8000-000000000040',
        escrowHoldId: HOLD_ID,
        startAt: '2026-05-01T10:00:00.000Z',
        endAt: '2026-05-01T11:00:00.000Z',
        totalCents: 112_600,
        currency: 'ZAR',
        completedAt: '2026-05-01T13:00:00.000Z',
        completionReason: 'AUTO_COMPLETE',
      }),
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('bookings.completed catches ESCROW_ILLEGAL_TRANSITION from release → ack', async () => {
    const { handler, release } = makeHandler();
    release.mockRejectedValueOnce(new AppException(ErrorCode.ESCROW_ILLEGAL_TRANSITION));
    await expect(
      handler.handle(
        envelope('bookings.completed', {
          bookingId: BOOKING_ID,
          clientId: CLIENT_ID,
          artistId: ARTIST_ID,
          serviceId: '01910000-0000-7000-8000-000000000040',
          escrowHoldId: HOLD_ID,
          startAt: '2026-05-01T10:00:00.000Z',
          endAt: '2026-05-01T11:00:00.000Z',
          totalCents: 112_600,
          currency: 'ZAR',
          completedAt: '2026-05-01T13:00:00.000Z',
          completionReason: 'AUTO_COMPLETE',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  // ── bookings.cancelled — refund-policy mapping ─────────────────────────

  it('FULL_REFUND + CLIENT → issueRefund({full, CLIENT, client-tiered})', async () => {
    const { handler, issueRefund } = makeHandler();
    await handler.handle(
      envelope('bookings.cancelled', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        escrowHoldId: HOLD_ID,
        cancelledBy: CLIENT_ID,
        actorRole: 'CLIENT',
        reason: 'changed plans',
        refundPolicy: 'FULL_REFUND',
        cancelledAt: '2026-05-01T08:00:00.000Z',
      }),
    );
    expect(issueRefund).toHaveBeenCalledTimes(1);
    expect(issueRefund).toHaveBeenCalledWith({
      holdId: HOLD_ID,
      full: true,
      faultParty: 'CLIENT',
      reason: 'booking-cancelled-client-tiered',
      actorId: SYSTEM_USER_ID,
    });
  });

  it('FULL_REFUND + ARTIST → issueRefund({full, ARTIST, artist-fault})', async () => {
    const { handler, issueRefund } = makeHandler();
    await handler.handle(
      envelope('bookings.cancelled', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        escrowHoldId: HOLD_ID,
        cancelledBy: ARTIST_ID,
        actorRole: 'ARTIST',
        reason: 'artist no-show',
        refundPolicy: 'FULL_REFUND',
        cancelledAt: '2026-05-01T08:00:00.000Z',
      }),
    );
    expect(issueRefund).toHaveBeenCalledWith({
      holdId: HOLD_ID,
      full: true,
      faultParty: 'ARTIST',
      reason: 'booking-cancelled-artist-fault',
      actorId: SYSTEM_USER_ID,
    });
  });

  it('PARTIAL_REFUND + CLIENT → issueRefund({refundCents, CLIENT, partial})', async () => {
    const { handler, issueRefund } = makeHandler();
    await handler.handle(
      envelope('bookings.cancelled', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        escrowHoldId: HOLD_ID,
        cancelledBy: CLIENT_ID,
        actorRole: 'CLIENT',
        reason: 'late notice',
        refundPolicy: 'PARTIAL_REFUND',
        partialRefundCents: 40_000,
        cancelledAt: '2026-05-01T08:00:00.000Z',
      }),
    );
    expect(issueRefund).toHaveBeenCalledWith({
      holdId: HOLD_ID,
      refundCents: 40_000n,
      faultParty: 'CLIENT',
      reason: 'booking-cancelled-partial',
      actorId: SYSTEM_USER_ID,
    });
  });

  it('NO_REFUND → EscrowService.release (artist keeps payment)', async () => {
    const { handler, release, issueRefund } = makeHandler();
    await handler.handle(
      envelope('bookings.cancelled', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        escrowHoldId: HOLD_ID,
        cancelledBy: CLIENT_ID,
        actorRole: 'CLIENT',
        reason: 'no-show by client',
        refundPolicy: 'NO_REFUND',
        cancelledAt: '2026-05-01T08:00:00.000Z',
      }),
    );
    expect(issueRefund).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(HOLD_ID, {
      actorId: null,
      note: 'no-refund cancellation: artist keeps full payment',
    });
  });

  it('bookings.cancelled with no escrow hold → log + ack (no service calls)', async () => {
    const { handler, release, issueRefund } = makeHandler(
      null as unknown as Partial<typeof baseHold>,
    );
    await handler.handle(
      envelope('bookings.cancelled', {
        bookingId: BOOKING_ID,
        clientId: CLIENT_ID,
        artistId: ARTIST_ID,
        escrowHoldId: HOLD_ID,
        cancelledBy: CLIENT_ID,
        actorRole: 'CLIENT',
        reason: 'pre-payment cancel',
        refundPolicy: 'FULL_REFUND',
        cancelledAt: '2026-05-01T08:00:00.000Z',
      }),
    );
    expect(issueRefund).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('PAYFAST_UPSTREAM_FAILURE on refund → re-thrown (subscriber NACKs)', async () => {
    const { handler, issueRefund } = makeHandler();
    issueRefund.mockRejectedValueOnce(new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE));
    await expect(
      handler.handle(
        envelope('bookings.cancelled', {
          bookingId: BOOKING_ID,
          clientId: CLIENT_ID,
          artistId: ARTIST_ID,
          escrowHoldId: HOLD_ID,
          cancelledBy: CLIENT_ID,
          actorRole: 'CLIENT',
          reason: 'reason',
          refundPolicy: 'FULL_REFUND',
          cancelledAt: '2026-05-01T08:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(AppException);
  });

  it('ESCROW_ILLEGAL_TRANSITION on refund (already REFUNDED) → ack', async () => {
    const { handler, issueRefund } = makeHandler();
    issueRefund.mockRejectedValueOnce(new AppException(ErrorCode.ESCROW_ILLEGAL_TRANSITION));
    await expect(
      handler.handle(
        envelope('bookings.cancelled', {
          bookingId: BOOKING_ID,
          clientId: CLIENT_ID,
          artistId: ARTIST_ID,
          escrowHoldId: HOLD_ID,
          cancelledBy: CLIENT_ID,
          actorRole: 'CLIENT',
          reason: 'reason',
          refundPolicy: 'FULL_REFUND',
          cancelledAt: '2026-05-01T08:00:00.000Z',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  // ── bookings.disputed ─────────────────────────────────────────────────

  it('bookings.disputed on HELD hold → EscrowService.freeze with reason', async () => {
    const { handler, freeze } = makeHandler();
    await handler.handle(
      envelope('bookings.disputed', {
        bookingId: BOOKING_ID,
        disputeId: '01910000-0000-7000-8000-000000000050',
        escrowHoldId: HOLD_ID,
        openedBy: CLIENT_ID,
        actorRole: 'CLIENT',
        subject: 'did not show',
        openedAt: '2026-05-02T08:00:00.000Z',
      }),
    );
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(freeze).toHaveBeenCalledWith(HOLD_ID, {
      reason: 'bookings.disputed',
      actorId: null,
    });
  });

  it('bookings.disputed when already DISPUTED → noop (no freeze call)', async () => {
    const { handler, freeze } = makeHandler({ state: EscrowState.DISPUTED });
    await handler.handle(
      envelope('bookings.disputed', {
        bookingId: BOOKING_ID,
        disputeId: '01910000-0000-7000-8000-000000000050',
        escrowHoldId: HOLD_ID,
        openedBy: CLIENT_ID,
        actorRole: 'CLIENT',
        subject: 'did not show',
        openedAt: '2026-05-02T08:00:00.000Z',
      }),
    );
    expect(freeze).not.toHaveBeenCalled();
  });

  it('bookings.disputed on RELEASED hold → noop (cannot freeze terminal)', async () => {
    const { handler, freeze } = makeHandler({ state: EscrowState.RELEASED });
    await handler.handle(
      envelope('bookings.disputed', {
        bookingId: BOOKING_ID,
        disputeId: '01910000-0000-7000-8000-000000000050',
        escrowHoldId: HOLD_ID,
        openedBy: CLIENT_ID,
        actorRole: 'CLIENT',
        subject: 'did not show',
        openedAt: '2026-05-02T08:00:00.000Z',
      }),
    );
    expect(freeze).not.toHaveBeenCalled();
  });

  // ── payload validation ─────────────────────────────────────────────────

  it('rejects bookings.cancelled when refundPolicy enum invalid', async () => {
    const { handler } = makeHandler();
    await expect(
      handler.handle(
        envelope('bookings.cancelled', {
          bookingId: BOOKING_ID,
          clientId: CLIENT_ID,
          artistId: ARTIST_ID,
          escrowHoldId: HOLD_ID,
          cancelledBy: CLIENT_ID,
          actorRole: 'CLIENT',
          reason: 'reason',
          refundPolicy: 'NOT_A_POLICY',
          cancelledAt: '2026-05-01T08:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/refundPolicy must be one of/);
  });

  it('rejects bookings.cancelled with PARTIAL_REFUND but no partialRefundCents', async () => {
    const { handler } = makeHandler();
    await expect(
      handler.handle(
        envelope('bookings.cancelled', {
          bookingId: BOOKING_ID,
          clientId: CLIENT_ID,
          artistId: ARTIST_ID,
          escrowHoldId: HOLD_ID,
          cancelledBy: CLIENT_ID,
          actorRole: 'CLIENT',
          reason: 'reason',
          refundPolicy: 'PARTIAL_REFUND',
          cancelledAt: '2026-05-01T08:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/partialRefundCents/);
  });
});
