import { EscrowState } from '@prisma/client';
import { canTransition, isTerminal, nextState, type EscrowAction } from './escrow-state.machine';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';

/**
 * Unit coverage for the escrow lifecycle. Every LEGAL transition is asserted
 * here, plus every category of ILLEGAL transition the service needs to reject:
 *
 *   - mutations on terminal states (RELEASED, REFUNDED)
 *   - mutations on DISPUTED that are not resolve-* → ESCROW_FROZEN
 *   - mutations on HELD that are not in the table → ESCROW_ILLEGAL_TRANSITION
 *
 * Mirrors the data-engine booking-state.machine.spec pattern.
 */
describe('escrow-state.machine', () => {
  describe('legal transitions', () => {
    const cases: Array<[EscrowState, EscrowAction, EscrowState]> = [
      [EscrowState.HELD, 'RELEASE', EscrowState.RELEASED],
      [EscrowState.HELD, 'REFUND', EscrowState.REFUNDED],
      [EscrowState.HELD, 'PARTIAL_REFUND', EscrowState.PARTIALLY_REFUNDED],
      [EscrowState.HELD, 'FREEZE', EscrowState.DISPUTED],
      [EscrowState.PARTIALLY_REFUNDED, 'PARTIAL_REFUND', EscrowState.PARTIALLY_REFUNDED],
      [EscrowState.PARTIALLY_REFUNDED, 'RELEASE', EscrowState.RELEASED],
      [EscrowState.PARTIALLY_REFUNDED, 'FREEZE', EscrowState.DISPUTED],
      [EscrowState.DISPUTED, 'RESOLVE_RELEASE', EscrowState.RELEASED],
      [EscrowState.DISPUTED, 'RESOLVE_REFUND', EscrowState.REFUNDED],
      [EscrowState.DISPUTED, 'RESOLVE_SPLIT', EscrowState.REFUNDED],
    ];

    it.each(cases)('%s --%s--> %s', (from, action, expected) => {
      expect(canTransition(from, action)).toBe(true);
      expect(nextState(from, action)).toBe(expected);
    });
  });

  describe('illegal transitions throw ESCROW_ILLEGAL_TRANSITION', () => {
    // Each tuple is a transition the spec says must be rejected — and which
    // is NOT a DISPUTED-frozen case (those are tested below).
    const illegal: Array<[EscrowState, EscrowAction]> = [
      // RELEASED is terminal
      [EscrowState.RELEASED, 'RELEASE'],
      [EscrowState.RELEASED, 'REFUND'],
      [EscrowState.RELEASED, 'PARTIAL_REFUND'],
      [EscrowState.RELEASED, 'FREEZE'],
      [EscrowState.RELEASED, 'RESOLVE_RELEASE'],
      [EscrowState.RELEASED, 'RESOLVE_REFUND'],
      [EscrowState.RELEASED, 'RESOLVE_SPLIT'],
      // REFUNDED is terminal
      [EscrowState.REFUNDED, 'RELEASE'],
      [EscrowState.REFUNDED, 'REFUND'],
      [EscrowState.REFUNDED, 'PARTIAL_REFUND'],
      [EscrowState.REFUNDED, 'FREEZE'],
      [EscrowState.REFUNDED, 'RESOLVE_RELEASE'],
      [EscrowState.REFUNDED, 'RESOLVE_REFUND'],
      [EscrowState.REFUNDED, 'RESOLVE_SPLIT'],
      // HELD cannot accept a resolve-* (those are DISPUTED-only)
      [EscrowState.HELD, 'RESOLVE_RELEASE'],
      [EscrowState.HELD, 'RESOLVE_REFUND'],
      [EscrowState.HELD, 'RESOLVE_SPLIT'],
      // PARTIALLY_REFUNDED cannot drop straight to REFUNDED — it must go via
      // PARTIAL_REFUND incrementing to the held amount, or be frozen first.
      [EscrowState.PARTIALLY_REFUNDED, 'REFUND'],
      [EscrowState.PARTIALLY_REFUNDED, 'RESOLVE_RELEASE'],
      [EscrowState.PARTIALLY_REFUNDED, 'RESOLVE_REFUND'],
      [EscrowState.PARTIALLY_REFUNDED, 'RESOLVE_SPLIT'],
    ];

    it.each(illegal)('%s --%s--> throws ILLEGAL_TRANSITION', (from, action) => {
      expect(canTransition(from, action)).toBe(false);
      try {
        nextState(from, action);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(ErrorCode.ESCROW_ILLEGAL_TRANSITION);
      }
    });
  });

  describe('DISPUTED is frozen for everything except RESOLVE_*', () => {
    const frozenAttempts: EscrowAction[] = ['RELEASE', 'REFUND', 'PARTIAL_REFUND', 'FREEZE'];

    it.each(frozenAttempts)('DISPUTED --%s--> throws ESCROW_FROZEN', (action) => {
      expect(canTransition(EscrowState.DISPUTED, action)).toBe(false);
      try {
        nextState(EscrowState.DISPUTED, action);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(ErrorCode.ESCROW_FROZEN);
      }
    });
  });

  it('terminal flag', () => {
    expect(isTerminal(EscrowState.RELEASED)).toBe(true);
    expect(isTerminal(EscrowState.REFUNDED)).toBe(true);
    expect(isTerminal(EscrowState.HELD)).toBe(false);
    expect(isTerminal(EscrowState.PARTIALLY_REFUNDED)).toBe(false);
    expect(isTerminal(EscrowState.DISPUTED)).toBe(false);
  });
});
