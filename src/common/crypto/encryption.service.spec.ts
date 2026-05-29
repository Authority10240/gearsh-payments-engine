import { EncryptionService } from './encryption.service';

/**
 * Unit coverage for the pure `mask()` helper. encrypt/decrypt require
 * Postgres + pgcrypto so they're covered by the payouts e2e spec
 * (which runs against testcontainers) — see test/payouts.e2e-spec.ts.
 */
describe('EncryptionService.mask', () => {
  // No DI for the pure helper — we hand-construct with stub deps. The mask
  // method does not touch this.config or this.prisma so the stubs are fine.
  const svc = new EncryptionService(
    { payoutMethodEncryptionKey: 'unit-test-key' } as never,
    {} as never,
  );

  it('redacts everything but the last 4 digits of a 10-char account number', () => {
    expect(svc.mask('1234567890')).toBe('••••••7890');
  });

  it('redacts a 5-char account number to 1 dot + last 4', () => {
    expect(svc.mask('12345')).toBe('•2345');
  });

  it('passes through 4-char strings unchanged (nothing to mask)', () => {
    expect(svc.mask('1234')).toBe('1234');
  });

  it('passes through strings shorter than 4 unchanged', () => {
    expect(svc.mask('12')).toBe('12');
    expect(svc.mask('1')).toBe('1');
  });

  it('handles empty strings', () => {
    expect(svc.mask('')).toBe('');
  });

  it('preserves leading zeros (account numbers can start with 0)', () => {
    expect(svc.mask('0001234567')).toBe('••••••4567');
  });

  it('redacts max-length SA account numbers (34 chars per IBAN)', () => {
    const acct = '1234567890123456789012345678901234'; // 34 chars
    const masked = svc.mask(acct);
    expect(masked.endsWith('1234')).toBe(true);
    expect(masked.length).toBe(34);
    expect(masked.startsWith('••••••')).toBe(true);
  });
});
