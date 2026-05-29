import { Injectable } from '@nestjs/common';
import { LedgerAccount, LedgerDirection } from '@prisma/client';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';

/**
 * Pure ledger primitives — extracted from PAY-002's payfast-webhook.service so
 * the escrow state machine (PAY-003), the refund flow (PAY-004), and any future
 * money-moving handler share one helper for entry construction + balance
 * assertion (gearsh-payments-engine.md §Ledger invariants).
 *
 * No DB access. Callers stitch the returned LedgerEntryInput[] into a Prisma
 * createMany inside their own atomic $transaction so the event + entries land
 * together.
 */

export interface LedgerEntryInput {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: bigint;
}

/**
 * Side of a refund (per business-rules §8.5). CLIENT-initiated full refunds
 * keep the platform fee; ARTIST-fault FULL refunds reverse PLATFORM_REVENUE
 * for the fee amount; SPLIT outcomes are non-refundable on the fee and use the
 * dedicated buildSplitEntries() helper.
 */
export type FaultParty = 'CLIENT' | 'ARTIST' | 'SPLIT';

/** Subset of EscrowHold fields the helpers need (decouples from Prisma model). */
export interface HoldSnapshot {
  amountCents: bigint;
  platformFeeCents: bigint;
}

@Injectable()
export class LedgerService {
  /**
   * RELEASE the entire held amount to the artist payable account.
   *   DEBIT  ESCROW_LIABILITY  hold.amountCents
   *   CREDIT ARTIST_PAYABLE    hold.amountCents
   * Used by EscrowService.release() and resolveRelease().
   */
  buildReleaseEntries(hold: HoldSnapshot): LedgerEntryInput[] {
    return buildReleaseEntriesPure(hold);
  }

  /** Same as buildReleaseEntries but for a *specific* amount (e.g. the remainder
   *  after partial refunds, or the artist portion of a SPLIT outcome). */
  buildReleaseEntriesForAmount(amountCents: bigint): LedgerEntryInput[] {
    return [
      {
        account: LedgerAccount.ESCROW_LIABILITY,
        direction: LedgerDirection.DEBIT,
        amountCents,
      },
      {
        account: LedgerAccount.ARTIST_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amountCents,
      },
    ];
  }

  /**
   * REFUND (full or partial) — business-rules §8.5.
   *
   *   Always:
   *     DEBIT  ESCROW_LIABILITY  refundCents
   *     CREDIT REFUNDS_ISSUED    refundCents
   *
   *   Plus, when faultParty === ARTIST AND it's a *full* refund:
   *     DEBIT  PLATFORM_REVENUE  hold.platformFeeCents
   *     CREDIT REFUNDS_ISSUED    hold.platformFeeCents
   *   …reversing the fee that was booked as revenue at escrow.held.
   *
   * "Full refund" = the refund covers everything currently held on the row;
   * for PARTIALLY_REFUNDED holds we ALSO require the partial-refunds-to-date +
   * this refund to equal the original amount — but that arithmetic lives in
   * the caller (EscrowService). This helper trusts the caller's `refundIsFull`
   * flag so it can be reused for the SPLIT-arrived-at-via-full-refund edge.
   */
  buildRefundEntries(
    hold: HoldSnapshot,
    refundCents: bigint,
    faultParty: FaultParty,
    refundIsFull: boolean,
  ): LedgerEntryInput[] {
    return buildRefundEntriesPure(hold, refundCents, faultParty, refundIsFull);
  }

  /**
   * SPLIT (dispute resolution) — business-rules §6 + §8.5.
   *
   *   DEBIT  ESCROW_LIABILITY  hold.amountCents (= artistCents + clientCents)
   *   CREDIT ARTIST_PAYABLE    artistCents
   *   CREDIT REFUNDS_ISSUED    clientCents
   *
   * The platform fee is non-refundable on a SPLIT outcome (it was recognised
   * at escrow.held and stays in PLATFORM_REVENUE). The artist+client split is
   * over the *held* amount only, which is already net of the fee.
   */
  buildSplitEntries(
    hold: HoldSnapshot,
    artistCents: bigint,
    clientCents: bigint,
  ): LedgerEntryInput[] {
    if (artistCents < 0n || clientCents < 0n) {
      throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
        detail: 'Split amounts must be non-negative.',
      });
    }
    if (artistCents + clientCents !== hold.amountCents) {
      throw new AppException(ErrorCode.BUSINESS_RULE_VIOLATION, {
        detail: `Split components (artistCents=${artistCents} + clientCents=${clientCents}) must equal hold.amountCents (${hold.amountCents}).`,
      });
    }
    return [
      {
        account: LedgerAccount.ESCROW_LIABILITY,
        direction: LedgerDirection.DEBIT,
        amountCents: hold.amountCents,
      },
      {
        account: LedgerAccount.ARTIST_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amountCents: artistCents,
      },
      {
        account: LedgerAccount.REFUNDS_ISSUED,
        direction: LedgerDirection.CREDIT,
        amountCents: clientCents,
      },
    ];
  }

  /** Σ DEBITS = Σ CREDITS per event (gearsh-payments-engine.md §Ledger). */
  assertBalanced(entries: LedgerEntryInput[]): void {
    assertBalanced(entries);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level pure helpers — exported separately so PAY-002's webhook service
// (which constructs entries before opening a Prisma transaction) and unit
// tests can use them without DI. The injectable wrapper above mirrors each.
// ─────────────────────────────────────────────────────────────────────────────

export function buildReleaseEntriesPure(hold: HoldSnapshot): LedgerEntryInput[] {
  return [
    {
      account: LedgerAccount.ESCROW_LIABILITY,
      direction: LedgerDirection.DEBIT,
      amountCents: hold.amountCents,
    },
    {
      account: LedgerAccount.ARTIST_PAYABLE,
      direction: LedgerDirection.CREDIT,
      amountCents: hold.amountCents,
    },
  ];
}

export function buildRefundEntriesPure(
  hold: HoldSnapshot,
  refundCents: bigint,
  faultParty: FaultParty,
  refundIsFull: boolean,
): LedgerEntryInput[] {
  if (refundCents < 0n) {
    throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
      detail: 'Refund amount must be non-negative.',
    });
  }
  if (refundCents > hold.amountCents) {
    throw new AppException(ErrorCode.REFUND_EXCEEDS_CAPTURE, {
      detail: `Refund amount ${refundCents} exceeds held amount ${hold.amountCents}.`,
    });
  }

  const entries: LedgerEntryInput[] = [
    {
      account: LedgerAccount.ESCROW_LIABILITY,
      direction: LedgerDirection.DEBIT,
      amountCents: refundCents,
    },
    {
      account: LedgerAccount.REFUNDS_ISSUED,
      direction: LedgerDirection.CREDIT,
      amountCents: refundCents,
    },
  ];

  // Artist-fault FULL refund — reverse the platform fee (business-rules §8.5).
  // Partial refunds never reverse the fee, even when artist-fault, by design:
  // the fee was charged on the whole booking and is only "made whole" when the
  // whole booking is rolled back.
  if (faultParty === 'ARTIST' && refundIsFull && hold.platformFeeCents > 0n) {
    entries.push({
      account: LedgerAccount.PLATFORM_REVENUE,
      direction: LedgerDirection.DEBIT,
      amountCents: hold.platformFeeCents,
    });
    entries.push({
      account: LedgerAccount.REFUNDS_ISSUED,
      direction: LedgerDirection.CREDIT,
      amountCents: hold.platformFeeCents,
    });
  }

  return entries;
}

/**
 * Σ DEBITS = Σ CREDITS per event. Throws LEDGER_IMBALANCE on imbalance or any
 * negative amount. An empty list is balanced (zero == zero) — the caller is
 * responsible for emitting at least one pair.
 *
 * Re-exported from the PAY-002 location for backwards compatibility with the
 * existing webhook service + its unit spec. PAY-003 callers should prefer the
 * injectable LedgerService.assertBalanced.
 */
export function assertBalanced(entries: LedgerEntryInput[]): void {
  let debits = 0n;
  let credits = 0n;
  for (const e of entries) {
    if (e.amountCents < 0n) {
      throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
        detail: 'Ledger entries must have non-negative amountCents.',
      });
    }
    if (e.direction === LedgerDirection.DEBIT) debits += e.amountCents;
    else credits += e.amountCents;
  }
  if (debits !== credits) {
    throw new AppException(ErrorCode.LEDGER_IMBALANCE, {
      detail: `Σ DEBITS (${debits}) != Σ CREDITS (${credits}).`,
    });
  }
}
