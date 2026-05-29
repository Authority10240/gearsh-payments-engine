import { buildSignatureString, signParams, verifySignature } from './signature.util';

/**
 * Unit tests for the PayFast MD5 signature pipeline. Vectors are constructed
 * from the rules in the PayFast Integration Guide
 * (https://developers.payfast.co.za/docs#signature):
 *
 *   1. Alphabetical sort by key.
 *   2. RFC 1738 form encoding (URLSearchParams output).
 *   3. Excludes empty values and the `signature` field itself.
 *   4. Appends &passphrase=<urlencoded> when configured.
 *
 * We don't hard-code MD5 hex digests from a remote test vector here because
 * the upstream "official" published examples are intermittently updated; the
 * tests instead lock the EXACT canonical string + verify the round-trip,
 * which is what the live ITN handler depends on.
 */
describe('PayFast signatures', () => {
  describe('buildSignatureString', () => {
    it('sorts params alphabetically and form-encodes values', () => {
      const out = buildSignatureString({
        merchant_id: '10000100',
        merchant_key: '46f0cd694581a',
        return_url: 'https://example.com/return',
        cancel_url: 'https://example.com/cancel',
        amount: '100.00',
        item_name: 'Test Product',
      });
      // Sorted: amount, cancel_url, item_name, merchant_id, merchant_key, return_url
      expect(out).toBe(
        [
          'amount=100.00',
          'cancel_url=https%3A%2F%2Fexample.com%2Fcancel',
          'item_name=Test+Product',
          'merchant_id=10000100',
          'merchant_key=46f0cd694581a',
          'return_url=https%3A%2F%2Fexample.com%2Freturn',
        ].join('&'),
      );
    });

    it('excludes empty and undefined values', () => {
      const out = buildSignatureString({
        merchant_id: '10000100',
        item_name: 'A',
        item_description: '',
        name_first: undefined,
        name_last: null,
      });
      expect(out).toBe(['item_name=A', 'merchant_id=10000100'].join('&'));
    });

    it('excludes the signature field itself', () => {
      const out = buildSignatureString({
        merchant_id: '10000100',
        signature: 'whatever',
      });
      expect(out).toBe('merchant_id=10000100');
    });

    it('appends &passphrase=… when supplied (urlencoded)', () => {
      const out = buildSignatureString({ merchant_id: '10000100' }, 'jt7NOE43FZPn');
      expect(out).toBe('merchant_id=10000100&passphrase=jt7NOE43FZPn');
    });

    it('urlencodes passphrase punctuation', () => {
      const out = buildSignatureString({ merchant_id: '10000100' }, 'p ass!@#$%');
      expect(out).toBe('merchant_id=10000100&passphrase=p+ass%21%40%23%24%25');
    });
  });

  describe('signParams + verifySignature', () => {
    const params = {
      merchant_id: '10000100',
      merchant_key: '46f0cd694581a',
      amount: '200.00',
      item_name: 'Booking #018f',
      return_url: 'https://payments.staging.thegearsh.app/return',
      cancel_url: 'https://payments.staging.thegearsh.app/cancel',
      notify_url: 'https://payments.staging.thegearsh.app/v1/webhooks/payfast',
      m_payment_id: '018f4c6e-7b23-7a90-8e1c-1d2f3a4b5c6d',
    };

    it('produces a 32-char lowercase MD5', () => {
      const sig = signParams(params, 'pp');
      expect(sig).toMatch(/^[0-9a-f]{32}$/);
    });

    it('round-trips: a freshly signed payload verifies', () => {
      const sig = signParams(params, 'pp');
      expect(verifySignature(params, sig, 'pp')).toBe(true);
    });

    it('detects tampering on any field', () => {
      const sig = signParams(params, 'pp');
      const tampered = { ...params, amount: '0.01' };
      expect(verifySignature(tampered, sig, 'pp')).toBe(false);
    });

    it('detects wrong passphrase', () => {
      const sig = signParams(params, 'pp');
      expect(verifySignature(params, sig, 'wrong')).toBe(false);
      expect(verifySignature(params, sig)).toBe(false);
    });

    it('verify is case-insensitive', () => {
      const sig = signParams(params, 'pp');
      expect(verifySignature(params, sig.toUpperCase(), 'pp')).toBe(true);
    });

    it('verify rejects empty signature', () => {
      expect(verifySignature(params, '', 'pp')).toBe(false);
    });

    it('signature is identical whether the inbound payload carried the signature field or not', () => {
      const withSig = signParams({ ...params, signature: 'ignored' }, 'pp');
      const withoutSig = signParams(params, 'pp');
      expect(withSig).toBe(withoutSig);
    });

    it('passphrase order matters: signing without passphrase is rejected by a passphrase-protected merchant', () => {
      const sigNoPp = signParams(params);
      const sigPp = signParams(params, 'pp');
      expect(sigNoPp).not.toBe(sigPp);
    });
  });
});
