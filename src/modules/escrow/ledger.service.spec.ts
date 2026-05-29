import { LedgerAccount, LedgerDirection } from '@prisma/client';
import {
  assertBalanced,
  buildRefundEntriesPure,
  buildReleaseEntriesPure,
  LedgerService,
} from './ledger.service';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';

/**
 * Pure-helper coverage for the extracted ledger service. The PayFast COMPLETE
 * triple's invariant lives in payfast-webhook.service.spec.ts (still works
 * after the extraction since assertBalanced is re-exported).
 *
 * Targets:
 *   - assertBalanced (negative + sum mismatch + empty)
 *   - buildReleaseEntriesPure shape
 *   - buildRefundEntriesPure with + without artist-fault (business-rules §8.5)
 *   - buildSplitEntries amount validation (artistCents + clientCents == held)
 */
describe('LedgerService — pure helpers', () => {
  const service = new LedgerService();
  const hold = { amountCents: 200_000n, platformFeeCents: 25_200n };

  describe('assertBalanced', () => {
    it('zero entries is balanced (defensive — caller emits at least one pair)', () => {
      expect(() => assertBalanced([])).not.toThrow();
    });

    it('throws on Σ DEBITS != Σ CREDITS', () => {
      expect(() =>
        assertBalanced([
          {
            account: LedgerAccount.ESCROW_LIABILITY,
            direction: LedgerDirection.DEBIT,
            amountCents: 100n,
          },
          {
            account: LedgerAccount.ARTIST_PAYABLE,
            direction: LedgerDirection.CREDIT,
            amountCents: 99n,
          },
        ]),
      ).toThrow(expect.objectContaining({ code: ErrorCode.LEDGER_IMBALANCE }));
    });

    it('throws on negative amount', () => {
      expect(() =>
        assertBalanced([
          {
            account: LedgerAccount.ESCROW_LIABILITY,
            direction: LedgerDirection.DEBIT,
            amountCents: -1n,
          },
        ]),
      ).toThrow(expect.objectContaining({ code: ErrorCode.LEDGER_IMBALANCE }));
    });
  });

  describe('buildReleaseEntries', () => {
    it('DEBIT ESCROW_LIABILITY + CREDIT ARTIST_PAYABLE for the full held amount', () => {
      const entries = buildReleaseEntriesPure(hold);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        account: LedgerAccount.ESCROW_LIABILITY,
        direction: LedgerDirection.DEBIT,
        amountCents: 200_000n,
      });
      expect(entries[1]).toEqual({
        account: LedgerAccount.ARTIST_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amountCents: 200_000n,
      });
      expect(() => assertBalanced(entries)).not.toThrow();
    });

    it('release for a smaller amount (PARTIALLY_REFUNDED remainder) balances', () => {
      const entries = service.buildReleaseEntriesForAmount(75_000n);
      expect(entries.map((e) => e.amountCents)).toEqual([75_000n, 75_000n]);
      expect(() => assertBalanced(entries)).not.toThrow();
    });
  });

  describe('buildRefundEntries', () => {
    it('CLIENT-fault FULL refund: 2 entries, fee stays with platform', () => {
      const entries = buildRefundEntriesPure(hold, hold.amountCents, 'CLIENT', true);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.account === LedgerAccount.PLATFORM_REVENUE)).toBeUndefined();
      expect(() => assertBalanced(entries)).not.toThrow();
    });

    it('ARTIST-fault FULL refund: 4 entries, PLATFORM_REVENUE reversed (§8.5)', () => {
      const entries = buildRefundEntriesPure(hold, hold.amountCents, 'ARTIST', true);
      expect(entries).toHaveLength(4);
      const revenueDebit = entries.find(
        (e) =>
          e.account === LedgerAccount.PLATFORM_REVENUE && e.direction === LedgerDirection.DEBIT,
      );
      expect(revenueDebit?.amountCents).toBe(25_200n);
      expect(() => assertBalanced(entries)).not.toThrow();
    });

    it('ARTIST-fault PARTIAL refund: 2 entries, fee not reversed on partials', () => {
      // refundIsFull=false → no fee reversal even when artist-fault.
      const entries = buildRefundEntriesPure(hold, 50_000n, 'ARTIST', false);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.account === LedgerAccount.PLATFORM_REVENUE)).toBeUndefined();
      expect(() => assertBalanced(entries)).not.toThrow();
    });

    it('rejects negative refund amount', () => {
      expect(() => buildRefundEntriesPure(hold, -1n, 'CLIENT', false)).toThrow(
        expect.objectContaining({ code: ErrorCode.LEDGER_IMBALANCE }),
      );
    });

    it('rejects refund > held amount', () => {
      expect(() => buildRefundEntriesPure(hold, hold.amountCents + 1n, 'CLIENT', true)).toThrow(
        expect.objectContaining({ code: ErrorCode.REFUND_EXCEEDS_CAPTURE }),
      );
    });
  });

  describe('buildSplitEntries', () => {
    it('valid split (50/50) produces 1 DEBIT + 2 CREDITS that balance', () => {
      const entries = service.buildSplitEntries(hold, 100_000n, 100_000n);
      expect(entries).toHaveLength(3);
      expect(entries.filter((e) => e.direction === LedgerDirection.DEBIT)).toHaveLength(1);
      expect(entries.filter((e) => e.direction === LedgerDirection.CREDIT)).toHaveLength(2);
      expect(() => assertBalanced(entries)).not.toThrow();
    });

    it('rejects split that does not sum to held amount', () => {
      expect(() => service.buildSplitEntries(hold, 100_000n, 100_001n)).toThrow(
        expect.objectContaining({ code: ErrorCode.BUSINESS_RULE_VIOLATION }),
      );
    });

    it('rejects negative split components', () => {
      expect(() => service.buildSplitEntries(hold, -1n, 200_001n)).toThrow(
        expect.objectContaining({ code: ErrorCode.LEDGER_IMBALANCE }),
      );
    });
  });
});

// Sanity: the AppException is thrown with the right HTTP status (cross-check
// the error-codes table without resolving the full filter pipeline).
describe('ledger error → AppException', () => {
  it('LEDGER_IMBALANCE maps to status 409', () => {
    try {
      assertBalanced([
        {
          account: LedgerAccount.ESCROW_LIABILITY,
          direction: LedgerDirection.DEBIT,
          amountCents: 1n,
        },
      ]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).getStatus()).toBe(409);
    }
  });
});
