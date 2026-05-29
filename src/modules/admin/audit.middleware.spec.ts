import { MAX_AUDIT_BODY_BYTES, redactBody } from './audit.middleware';

/**
 * AdminAuditMiddleware (redactBody) unit tests — PAY-007.
 *
 * The transport piece (write timing + Prisma call) is exercised by the e2e
 * spec; here we lock down the redaction contract:
 *   - sensitive keys are replaced with `[REDACTED]` (case-insensitive,
 *     recursive across nested objects + arrays);
 *   - ≥ 8 consecutive digits anywhere in a string value are MASKED;
 *   - oversized bodies collapse to a truncated sentinel under the cap;
 *   - empty bodies pass through as undefined (Prisma stores SQL NULL).
 */
describe('AdminAuditMiddleware (redactBody)', () => {
  it('returns undefined for null / undefined bodies (stored as SQL NULL)', () => {
    expect(redactBody(undefined)).toBeUndefined();
    expect(redactBody(null)).toBeUndefined();
  });

  it('redacts sensitive top-level keys', () => {
    const out = redactBody({
      email: 'a@b.com',
      password: 'hunter2',
      accountNumber: '1234567890',
      token: 'tok-1',
      idempotencyKey: 'idem-1',
      reason: 'fine',
    }) as Record<string, unknown>;

    expect(out.email).toBe('a@b.com');
    expect(out.reason).toBe('fine');
    expect(out.password).toBe('[REDACTED]');
    expect(out.accountNumber).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.idempotencyKey).toBe('[REDACTED]');
  });

  it('redacts sensitive keys case-insensitively', () => {
    const out = redactBody({
      Password: 'x',
      ACCOUNTNUMBER: 'y',
      Token: 'z',
      IdempotencyKey: 'w',
    }) as Record<string, unknown>;
    expect(out.Password).toBe('[REDACTED]');
    expect(out.ACCOUNTNUMBER).toBe('[REDACTED]');
    expect(out.Token).toBe('[REDACTED]');
    expect(out.IdempotencyKey).toBe('[REDACTED]');
  });

  it('redacts nested objects + arrays of objects', () => {
    const out = redactBody({
      user: { id: 'u1', password: 'secret' },
      tokens: [{ token: 't1' }, { token: 't2' }],
      mixed: [1, 'two', { accountNumber: '1111-2222-3333' }],
    }) as Record<string, unknown>;

    expect((out.user as Record<string, unknown>).id).toBe('u1');
    expect((out.user as Record<string, unknown>).password).toBe('[REDACTED]');
    expect(out.tokens).toEqual([{ token: '[REDACTED]' }, { token: '[REDACTED]' }]);
    expect((out.mixed as unknown[])[2]).toEqual({ accountNumber: '[REDACTED]' });
  });

  it('masks ≥ 8 consecutive digits in free-form string values', () => {
    const out = redactBody({
      notes: 'Routed via account 1234567890 — confirm with client',
      shortDigits: '1234567',
      ref: 'REF-2026',
    }) as Record<string, unknown>;
    expect(out.notes).toBe('Routed via account [MASKED] — confirm with client');
    // < 8 digits stays untouched
    expect(out.shortDigits).toBe('1234567');
    expect(out.ref).toBe('REF-2026');
  });

  it('masks digits inside nested arrays / objects too', () => {
    const out = redactBody({
      bookings: [{ id: 'b1', card: '4242424242424242' }],
      meta: { trace: 'spanid-9876543210' },
    }) as Record<string, unknown>;
    const bookings = (out.bookings as Array<{ card: string }>)[0];
    expect(bookings.card).toBe('[MASKED]');
    expect((out.meta as Record<string, unknown>).trace).toBe('spanid-[MASKED]');
  });

  it('leaves non-sensitive keys + short strings untouched', () => {
    const input = {
      reason: 'manual close',
      toState: 'COMPLETED',
      meta: { ip: '1.2.3.4', port: 8080 },
    };
    const out = redactBody(input) as Record<string, unknown>;
    expect(out).toEqual(input);
  });

  it('truncates oversized bodies to a sentinel under the cap', () => {
    const big = 'x'.repeat(12 * 1024);
    const out = redactBody({ blob: big }) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(typeof out.sizeBytes).toBe('number');
    expect(out.sizeBytes as number).toBeGreaterThan(MAX_AUDIT_BODY_BYTES);
    expect(typeof out.preview).toBe('string');
    expect((out.preview as string).length).toBeLessThanOrEqual(256);
  });

  it('handles scalar bodies by stringifying + truncating', () => {
    expect(redactBody(42)).toBe('42');
    expect(redactBody('hello')).toBe('hello');
    const huge = 'a'.repeat(MAX_AUDIT_BODY_BYTES + 1000);
    const out = redactBody(huge) as string;
    expect(out.length).toBe(MAX_AUDIT_BODY_BYTES);
  });
});
