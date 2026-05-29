import { backoffHoursFor } from './payout-retry.job';

/**
 * Unit coverage for the PAY-005 retry-backoff schedule. The spec is
 * "min(24, 2 ** attempts)" with PAYOUT_MAX_ATTEMPTS=5 — verify the table
 * and the cap.
 */
describe('PayoutRetryJob.backoffHoursFor', () => {
  it('produces the 1/2/4/8/16 doubling sequence for attempts 0..4', () => {
    expect(backoffHoursFor(0)).toBe(1);
    expect(backoffHoursFor(1)).toBe(2);
    expect(backoffHoursFor(2)).toBe(4);
    expect(backoffHoursFor(3)).toBe(8);
    expect(backoffHoursFor(4)).toBe(16);
  });

  it('caps at 24h once 2^attempts exceeds 24', () => {
    expect(backoffHoursFor(5)).toBe(24); // 32 → capped
    expect(backoffHoursFor(6)).toBe(24);
    expect(backoffHoursFor(10)).toBe(24);
  });

  it('defends against negative input', () => {
    expect(backoffHoursFor(-1)).toBe(1);
  });
});
