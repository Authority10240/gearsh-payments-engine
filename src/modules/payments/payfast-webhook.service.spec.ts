import { LedgerAccount, LedgerDirection } from '@prisma/client';
import { assertBalanced } from './payfast-webhook.service';

/**
 * Unit tests for the small pure helpers in payfast-webhook.service. The
 * end-to-end pipeline (signature → validate → atomic transaction) lives in
 * the e2e spec (payfast-webhook.e2e-spec.ts) where it runs against real
 * Postgres + Redis testcontainers.
 *
 * The ledger balance helper here covers the COMPLETE path's invariant
 * (gearsh-payments-engine.md §Ledger: Σ DEBITS = Σ CREDITS per event).
 */
describe('PayFast webhook — ledger balance helper', () => {
  const debit = LedgerDirection.DEBIT;
  const credit = LedgerDirection.CREDIT;

  it('accepts the canonical PAY-002 COMPLETE triple (1 DEBIT, 2 CREDITS summing to debit)', () => {
    expect(() =>
      assertBalanced([
        { account: LedgerAccount.PAYFAST_SETTLEMENT, direction: debit, amountCents: 225200n },
        { account: LedgerAccount.ESCROW_LIABILITY, direction: credit, amountCents: 200000n },
        { account: LedgerAccount.PLATFORM_REVENUE, direction: credit, amountCents: 25200n },
      ]),
    ).not.toThrow();
  });

  it('rejects an imbalance (CREDITS > DEBITS)', () => {
    expect(() =>
      assertBalanced([
        { account: LedgerAccount.PAYFAST_SETTLEMENT, direction: debit, amountCents: 100000n },
        { account: LedgerAccount.ESCROW_LIABILITY, direction: credit, amountCents: 100001n },
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_IMBALANCE' }));
  });

  it('rejects an imbalance (DEBITS > CREDITS)', () => {
    expect(() =>
      assertBalanced([
        { account: LedgerAccount.PAYFAST_SETTLEMENT, direction: debit, amountCents: 100000n },
        { account: LedgerAccount.ESCROW_LIABILITY, direction: credit, amountCents: 99999n },
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_IMBALANCE' }));
  });

  it('rejects negative amounts', () => {
    expect(() =>
      assertBalanced([
        { account: LedgerAccount.PAYFAST_SETTLEMENT, direction: debit, amountCents: -1n },
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_IMBALANCE' }));
  });

  it('an empty entry list is balanced (zero == zero) — caller is responsible for emitting at least one pair', () => {
    expect(() => assertBalanced([])).not.toThrow();
  });
});
