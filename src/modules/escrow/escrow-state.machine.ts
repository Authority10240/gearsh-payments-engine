import { EscrowState } from '@prisma/client';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';

/**
 * Escrow lifecycle state machine — gearsh-payments-engine.md §State machine
 * (escrow), business-rules §6 (disputes) + §8.5 (fee on refunds).
 *
 *   payments.succeeded ──▶ HELD                    (created by PAY-002 webhook;
 *                                                   PAY-003 only observes it)
 *
 *   HELD ──release──▶ RELEASED                     → payouts row queued
 *   HELD ──refund──▶ REFUNDED                      (full)
 *   HELD ──partial-refund──▶ PARTIALLY_REFUNDED    (running total)
 *   HELD ──freeze──▶ DISPUTED
 *
 *   PARTIALLY_REFUNDED ──partial-refund──▶ PARTIALLY_REFUNDED  (further partials)
 *   PARTIALLY_REFUNDED ──release-remainder──▶ RELEASED         (pays the remainder)
 *   PARTIALLY_REFUNDED ──freeze──▶ DISPUTED
 *
 *   DISPUTED ──resolve-release──▶ RELEASED
 *   DISPUTED ──resolve-refund──▶ REFUNDED
 *   DISPUTED ──resolve-split──▶ REFUNDED           (booked as artist-release +
 *                                                   client-refund in the same
 *                                                   atomic transaction)
 *
 *   RELEASED → terminal
 *   REFUNDED → terminal
 *
 * Anything operating on a DISPUTED hold that isn't one of the three resolve-*
 * actions throws ESCROW_FROZEN (409). All other illegal transitions throw
 * ESCROW_ILLEGAL_TRANSITION (409). Both maps to RFC 7807 via the global
 * ProblemFilter (contracts/errors.md §Payments).
 *
 * Implemented as a typed transition table + a tiny pure resolver. xstate is
 * not (yet) a dep of the payments engine — the data engine uses it for the
 * larger bookings machine; here a transition table is shorter and just as
 * exhaustive, and matches the rest of the in-repo style.
 */

/** Logical actions the service or admin route can apply to a hold. */
export type EscrowAction =
  | 'RELEASE' // HELD | PARTIALLY_REFUNDED  → RELEASED
  | 'REFUND' // HELD                      → REFUNDED       (full refund)
  | 'PARTIAL_REFUND' // HELD | PARTIALLY_REFUNDED  → PARTIALLY_REFUNDED
  | 'FREEZE' // HELD | PARTIALLY_REFUNDED  → DISPUTED
  | 'RESOLVE_RELEASE' // DISPUTED                  → RELEASED
  | 'RESOLVE_REFUND' // DISPUTED                  → REFUNDED
  | 'RESOLVE_SPLIT'; // DISPUTED                  → REFUNDED  (artist + client split)

/** Pure transition table — single source of truth. */
const TRANSITIONS: Record<EscrowState, Partial<Record<EscrowAction, EscrowState>>> = {
  [EscrowState.HELD]: {
    RELEASE: EscrowState.RELEASED,
    REFUND: EscrowState.REFUNDED,
    PARTIAL_REFUND: EscrowState.PARTIALLY_REFUNDED,
    FREEZE: EscrowState.DISPUTED,
  },
  [EscrowState.PARTIALLY_REFUNDED]: {
    // Release-remainder pays the artist what's left after running partials.
    RELEASE: EscrowState.RELEASED,
    // Further partials stay in PARTIALLY_REFUNDED (running total on the hold).
    PARTIAL_REFUND: EscrowState.PARTIALLY_REFUNDED,
    FREEZE: EscrowState.DISPUTED,
  },
  [EscrowState.DISPUTED]: {
    RESOLVE_RELEASE: EscrowState.RELEASED,
    RESOLVE_REFUND: EscrowState.REFUNDED,
    // SPLIT books one refund event AND one release event in the same DB
    // transaction; the hold's *terminal* state is REFUNDED (the artist portion
    // moves to ARTIST_PAYABLE via a payouts row, exactly like RELEASE).
    RESOLVE_SPLIT: EscrowState.REFUNDED,
  },
  [EscrowState.RELEASED]: {},
  [EscrowState.REFUNDED]: {},
};

/** Actions that are legal against a DISPUTED hold. Anything else triggers
 *  ESCROW_FROZEN rather than the generic ESCROW_ILLEGAL_TRANSITION. */
const FROZEN_BYPASS_ACTIONS: ReadonlySet<EscrowAction> = new Set([
  'RESOLVE_RELEASE',
  'RESOLVE_REFUND',
  'RESOLVE_SPLIT',
]);

/** True iff `action` is a legal transition from `from`. */
export function canTransition(from: EscrowState, action: EscrowAction): boolean {
  return TRANSITIONS[from]?.[action] !== undefined;
}

/**
 * Resolve `(from, action)` to the target state OR throw the right RFC 7807
 * exception:
 *
 *   - DISPUTED + (anything other than RESOLVE_*) → ESCROW_FROZEN (409)
 *   - Anything else illegal → ESCROW_ILLEGAL_TRANSITION (409)
 *
 * Self-loops (PARTIAL_REFUND on PARTIALLY_REFUNDED) are legal and return the
 * same state; the caller is responsible for incrementing the running total.
 */
export function nextState(from: EscrowState, action: EscrowAction): EscrowState {
  const target = TRANSITIONS[from]?.[action];
  if (target !== undefined) return target;

  if (from === EscrowState.DISPUTED && !FROZEN_BYPASS_ACTIONS.has(action)) {
    throw new AppException(ErrorCode.ESCROW_FROZEN, {
      detail: `Hold is DISPUTED; cannot apply ${action}. Use resolve-release, resolve-refund, or resolve-split.`,
    });
  }

  throw new AppException(ErrorCode.ESCROW_ILLEGAL_TRANSITION, {
    detail: `Cannot apply ${action} to a hold in state ${from}.`,
  });
}

/** True iff the state is terminal in the forward direction (no outgoing edges). */
export function isTerminal(state: EscrowState): boolean {
  return Object.keys(TRANSITIONS[state] ?? {}).length === 0;
}
