import { EscrowState, PayoutState, RefundState } from '@prisma/client';
import { AdminService } from './admin.service';
import type { AppConfig } from '../../config/configuration';

/**
 * Stuck-state finder predicates (PAY-007). The full reconciliation and
 * audit-listing surface is exercised in the e2e spec; this file pins the
 * query construction so a refactor of the threshold logic stays guarded.
 */
describe('AdminService — stuck-state predicates', () => {
  const config = {
    reconciliation: {
      enabled: true,
      alertThresholdCents: 1000,
      stuckHoldHours: 72,
      stuckPayoutHours: 24,
      stuckDisputeDays: 14,
    },
  } as unknown as AppConfig;

  function build(prismaOverrides: Record<string, unknown>): AdminService {
    return new AdminService(
      config,
      prismaOverrides as never,
      { runForDate: jest.fn(), getRunById: jest.fn() } as never,
    );
  }

  describe('stuckHolds', () => {
    it('queries HELD rows older than the configured threshold', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const service = build({ escrowHold: { findMany } });
      await service.stuckHolds();
      const args = findMany.mock.calls[0][0];
      expect(args.where.state).toBe(EscrowState.HELD);
      const cutoff = args.where.heldAt.lt as Date;
      const ageHours = (Date.now() - cutoff.getTime()) / (60 * 60 * 1000);
      expect(ageHours).toBeGreaterThan(71.5);
      expect(ageHours).toBeLessThan(72.5);
    });

    it('projects amounts as strings and computes ageHours', async () => {
      const heldAt = new Date(Date.now() - 100 * 60 * 60 * 1000); // 100h ago
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'hold-1',
          bookingId: 'b-1',
          artistId: 'a-1',
          amountCents: 12_345n,
          heldAt,
        },
      ]);
      const service = build({ escrowHold: { findMany } });
      const out = await service.stuckHolds();
      expect(out.data).toHaveLength(1);
      expect(out.data[0].holdId).toBe('hold-1');
      expect(out.data[0].amountCents).toBe('12345');
      expect(out.data[0].ageHours).toBeGreaterThanOrEqual(99);
      expect(out.thresholdHours).toBe(72);
    });
  });

  describe('stuckPayouts', () => {
    it('queries QUEUED rows with dispatchAfter older than threshold', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const service = build({ payout: { findMany } });
      await service.stuckPayouts();
      const args = findMany.mock.calls[0][0];
      expect(args.where.state).toBe(PayoutState.QUEUED);
      const cutoff = args.where.dispatchAfter.lt as Date;
      const ageHours = (Date.now() - cutoff.getTime()) / (60 * 60 * 1000);
      expect(ageHours).toBeGreaterThan(23.5);
      expect(ageHours).toBeLessThan(24.5);
    });
  });

  describe('stuckDisputes', () => {
    it('queries DISPUTED rows with disputedAt older than threshold (in days)', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const service = build({ escrowHold: { findMany } });
      await service.stuckDisputes();
      const args = findMany.mock.calls[0][0];
      expect(args.where.state).toBe(EscrowState.DISPUTED);
      const cutoff = args.where.disputedAt.lt as Date;
      const ageDays = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
      expect(ageDays).toBeGreaterThan(13.5);
      expect(ageDays).toBeLessThan(14.5);
    });
  });

  describe('stuckRefunds', () => {
    it('returns refunds in FAILED whose underlying hold is still HELD', async () => {
      const refundFindMany = jest.fn().mockResolvedValue([
        {
          id: 'refund-1',
          amountCents: 1_000n,
          failureReason: 'gateway timeout',
          updatedAt: new Date(),
          transaction: { paymentIntentId: 'intent-1' },
        },
        {
          id: 'refund-2',
          amountCents: 2_000n,
          failureReason: 'gateway 5xx',
          updatedAt: new Date(),
          transaction: { paymentIntentId: 'intent-2' },
        },
      ]);
      const holdFindFirst = jest
        .fn()
        // first refund's hold is still HELD → surfaced
        .mockResolvedValueOnce({ id: 'hold-1', state: EscrowState.HELD })
        // second refund's hold already moved on to REFUNDED → filtered out
        .mockResolvedValueOnce({ id: 'hold-2', state: EscrowState.REFUNDED });

      const service = build({
        refund: { findMany: refundFindMany },
        escrowHold: { findFirst: holdFindFirst },
      });
      const out = await service.stuckRefunds();
      expect(out.data).toHaveLength(1);
      expect(out.data[0].refundId).toBe('refund-1');
      expect(out.data[0].holdId).toBe('hold-1');
      expect(refundFindMany.mock.calls[0][0].where.state).toBe(RefundState.FAILED);
    });
  });
});
