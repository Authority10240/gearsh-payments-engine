import { EscrowState, LedgerAccount, LedgerDirection } from '@prisma/client';
import {
  PAYFAST_RECONCILIATION_HISTORY,
  ReconciliationService,
  type PayFastReconciliationHistoryAdapter,
} from './reconciliation.service';
import type { AppConfig } from '../../config/configuration';

void PAYFAST_RECONCILIATION_HISTORY;

/**
 * Unit-level coverage for the invariant predicates (PAY-007).
 *
 * The cron + persistence wiring is exercised by the e2e spec — here we
 * stub PrismaService with the minimum surface area each predicate uses and
 * lock down both the balanced + imbalanced branches.
 *
 * Invariant A — Σ DEBIT vs Σ CREDIT per escrow_event (within the day window).
 * Invariant B — ESCROW_LIABILITY ledger balance vs Σ remaining held funds.
 * Invariant C — net PLATFORM_REVENUE is non-negative.
 */
describe('ReconciliationService — invariant predicates', () => {
  const config = {
    reconciliation: {
      enabled: true,
      alertThresholdCents: 1000,
      stuckHoldHours: 72,
      stuckPayoutHours: 24,
      stuckDisputeDays: 14,
    },
  } as unknown as AppConfig;

  const defaultPayfast = { enabled: false };
  const defaultAdapter: PayFastReconciliationHistoryAdapter = {
    fetchForDate: async () => null,
  };

  function makeService(
    prismaOverrides: Record<string, unknown>,
    payfastOverride: { enabled: boolean } = defaultPayfast,
    history: PayFastReconciliationHistoryAdapter = defaultAdapter,
  ): ReconciliationService {
    return new ReconciliationService(
      config,
      prismaOverrides as never,
      payfastOverride as never,
      history,
    );
  }

  describe('Invariant A — per-event balance', () => {
    it('returns NO findings when every event balances', async () => {
      const service = makeService({
        $queryRaw: jest.fn().mockResolvedValue([
          { event_id: 'evt-1', debit_total: 100n, credit_total: 100n },
          { event_id: 'evt-2', debit_total: 200n, credit_total: 200n },
        ]),
      });
      const findings = await service.checkInvariantAForWindow(
        new Date('2026-05-28T00:00:00Z'),
        new Date('2026-05-29T00:00:00Z'),
      );
      expect(findings).toEqual([]);
    });

    it('returns ONE HIGH finding per imbalanced event', async () => {
      const service = makeService({
        $queryRaw: jest.fn().mockResolvedValue([
          { event_id: 'evt-balanced', debit_total: 100n, credit_total: 100n },
          { event_id: 'evt-imbalanced', debit_total: 100n, credit_total: 90n },
          { event_id: 'evt-imbalanced-2', debit_total: 0n, credit_total: 50n },
        ]),
      });
      const findings = await service.checkInvariantAForWindow(
        new Date('2026-05-28T00:00:00Z'),
        new Date('2026-05-29T00:00:00Z'),
      );
      expect(findings).toHaveLength(2);
      expect(findings.every((f) => f.severity === 'HIGH')).toBe(true);
      expect(findings[0].code).toBe('INVARIANT_A_EVENT_IMBALANCE');
      expect(findings[0].context?.eventId).toBe('evt-imbalanced');
      expect(findings[1].context?.eventId).toBe('evt-imbalanced-2');
    });
  });

  describe('Invariant B — ESCROW_LIABILITY vs Σ held funds', () => {
    it('returns NO findings when ledger CREDIT − DEBIT == Σ remaining held', async () => {
      const service = makeService({
        ledgerEntry: {
          groupBy: jest.fn().mockResolvedValue([
            { direction: LedgerDirection.CREDIT, _sum: { amountCents: 500n } },
            { direction: LedgerDirection.DEBIT, _sum: { amountCents: 200n } },
          ]),
        },
        escrowHold: {
          findMany: jest.fn().mockResolvedValue([
            { amountCents: 200n, partiallyRefundedAmountCents: 0n },
            { amountCents: 100n, partiallyRefundedAmountCents: 0n },
          ]),
        },
      });
      const findings = await service.checkInvariantB();
      expect(findings).toEqual([]);
    });

    it('returns HIGH finding when drift exceeds the threshold', async () => {
      const service = makeService({
        ledgerEntry: {
          // Net CREDIT − DEBIT = 100_000
          groupBy: jest
            .fn()
            .mockResolvedValue([
              { direction: LedgerDirection.CREDIT, _sum: { amountCents: 100_000n } },
            ]),
        },
        escrowHold: {
          // Σ remaining held = 50_000 → drift = 50_000, threshold = 1_000
          findMany: jest
            .fn()
            .mockResolvedValue([{ amountCents: 50_000n, partiallyRefundedAmountCents: 0n }]),
        },
      });
      const findings = await service.checkInvariantB();
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('INVARIANT_B_ESCROW_LIABILITY_DRIFT');
      expect(findings[0].severity).toBe('HIGH');
      expect(findings[0].context?.driftCents).toBe('50000');
    });

    it('returns LOW finding when drift is non-zero but ≤ threshold', async () => {
      const service = makeService({
        ledgerEntry: {
          groupBy: jest
            .fn()
            .mockResolvedValue([
              { direction: LedgerDirection.CREDIT, _sum: { amountCents: 1_500n } },
            ]),
        },
        escrowHold: {
          // Σ remaining = 1_000 → drift = 500, threshold = 1_000
          findMany: jest
            .fn()
            .mockResolvedValue([{ amountCents: 1_000n, partiallyRefundedAmountCents: 0n }]),
        },
      });
      const findings = await service.checkInvariantB();
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('LOW');
    });

    it('subtracts partial refunds from the held side', async () => {
      const service = makeService({
        ledgerEntry: {
          // Net = 7_000
          groupBy: jest.fn().mockResolvedValue([
            { direction: LedgerDirection.CREDIT, _sum: { amountCents: 10_000n } },
            { direction: LedgerDirection.DEBIT, _sum: { amountCents: 3_000n } },
          ]),
        },
        escrowHold: {
          // 10_000 held minus 3_000 already partial-refunded = 7_000 → no drift
          findMany: jest
            .fn()
            .mockResolvedValue([{ amountCents: 10_000n, partiallyRefundedAmountCents: 3_000n }]),
        },
      });
      const findings = await service.checkInvariantB();
      expect(findings).toEqual([]);
    });

    it('only counts holds in HELD / PARTIALLY_REFUNDED / DISPUTED', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const service = makeService({
        ledgerEntry: { groupBy: jest.fn().mockResolvedValue([]) },
        escrowHold: { findMany },
      });
      await service.checkInvariantB();
      const where = findMany.mock.calls[0][0]?.where;
      expect(where.state.in).toEqual([
        EscrowState.HELD,
        EscrowState.PARTIALLY_REFUNDED,
        EscrowState.DISPUTED,
      ]);
    });
  });

  describe('Invariant C — net PLATFORM_REVENUE non-negative', () => {
    it('returns NO findings when net revenue is positive', async () => {
      const service = makeService({
        ledgerEntry: {
          groupBy: jest.fn().mockResolvedValue([
            { direction: LedgerDirection.CREDIT, _sum: { amountCents: 200n } },
            { direction: LedgerDirection.DEBIT, _sum: { amountCents: 50n } },
          ]),
        },
      });
      const findings = await service.checkInvariantC();
      expect(findings).toEqual([]);
    });

    it('returns NO findings when net revenue is exactly zero', async () => {
      const service = makeService({
        ledgerEntry: {
          groupBy: jest.fn().mockResolvedValue([
            { direction: LedgerDirection.CREDIT, _sum: { amountCents: 100n } },
            { direction: LedgerDirection.DEBIT, _sum: { amountCents: 100n } },
          ]),
        },
      });
      const findings = await service.checkInvariantC();
      expect(findings).toEqual([]);
    });

    it('returns HIGH finding when net revenue is negative', async () => {
      const service = makeService({
        ledgerEntry: {
          groupBy: jest.fn().mockResolvedValue([
            { direction: LedgerDirection.CREDIT, _sum: { amountCents: 100n } },
            { direction: LedgerDirection.DEBIT, _sum: { amountCents: 250n } },
          ]),
        },
      });
      const findings = await service.checkInvariantC();
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('INVARIANT_C_PLATFORM_REVENUE_NEGATIVE');
      expect(findings[0].severity).toBe('HIGH');
      expect(findings[0].context?.netRevenueCents).toBe('-150');
    });
  });

  describe('PayFast cross-check', () => {
    it('emits a HIGH finding when a PayFast COMPLETE txn has no local SUCCEEDED row', async () => {
      const service = makeService({
        transaction: { findFirst: jest.fn().mockResolvedValue(null) },
        refund: { findFirst: jest.fn() },
        payout: { findFirst: jest.fn() },
      });
      const findings = await service.checkPayFastAgainstLocal(
        {
          transactions: [{ pfPaymentId: 'pf-1', amountCents: 100n, status: 'COMPLETE' }],
          refunds: [],
          payouts: [],
        },
        new Date('2026-05-28T00:00:00Z'),
        new Date('2026-05-29T00:00:00Z'),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('PAYFAST_TRANSACTION_MISSING_LOCAL');
      expect(findings[0].severity).toBe('HIGH');
    });

    it('emits HIGH finding when amounts differ', async () => {
      void LedgerAccount; // keep import; prevents unused complaint in some configs
      const service = makeService({
        transaction: {
          findFirst: jest.fn().mockResolvedValue({
            amountCents: 99n,
            state: 'SUCCEEDED',
            gatewayTxnId: 'pf-1',
          }),
        },
        refund: { findFirst: jest.fn() },
        payout: { findFirst: jest.fn() },
      });
      const findings = await service.checkPayFastAgainstLocal(
        {
          transactions: [{ pfPaymentId: 'pf-1', amountCents: 100n, status: 'COMPLETE' }],
          refunds: [],
          payouts: [],
        },
        new Date(),
        new Date(),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('PAYFAST_TRANSACTION_MISSING_LOCAL');
      expect(findings[0].detail).toContain('Amount mismatch');
    });

    it('emits a HIGH finding for a missing local refund row', async () => {
      const service = makeService({
        transaction: { findFirst: jest.fn() },
        refund: { findFirst: jest.fn().mockResolvedValue(null) },
        payout: { findFirst: jest.fn() },
      });
      const findings = await service.checkPayFastAgainstLocal(
        {
          transactions: [],
          refunds: [{ gatewayRefundId: 'r-1', amountCents: 50n }],
          payouts: [],
        },
        new Date(),
        new Date(),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('PAYFAST_REFUND_MISSING_LOCAL');
    });

    it('emits a HIGH finding for a missing local payout row', async () => {
      const service = makeService({
        transaction: { findFirst: jest.fn() },
        refund: { findFirst: jest.fn() },
        payout: { findFirst: jest.fn().mockResolvedValue(null) },
      });
      const findings = await service.checkPayFastAgainstLocal(
        {
          transactions: [],
          refunds: [],
          payouts: [{ gatewayPayoutId: 'po-1', amountCents: 75n }],
        },
        new Date(),
        new Date(),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('PAYFAST_PAYOUT_MISSING_LOCAL');
    });
  });
});
