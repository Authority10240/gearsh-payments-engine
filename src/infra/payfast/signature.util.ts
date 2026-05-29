import { createHash } from 'node:crypto';

/**
 * PayFast signature generation + verification.
 *
 * Per the PayFast Integration Guide (Process URL + ITN sections), the
 * signature is the MD5 hex digest of:
 *
 *   <urlencoded-form-params-sorted-by-key>[&passphrase=<urlencoded-passphrase>]
 *
 * Rules transcribed from the PayFast docs and the published test vectors
 * (https://developers.payfast.co.za/docs#signature):
 *
 *   1. ONLY the form-data parameters submitted to PayFast are signed; the
 *      `signature` field itself is excluded.
 *   2. Empty-string parameters are excluded.
 *   3. Parameters are sorted alphabetically by key (UTF-8 byte order, which
 *      matches lexicographic for ASCII keys).
 *   4. Each value is URL-encoded using the PHP `urlencode` semantics:
 *      RFC 1738 application/x-www-form-urlencoded — spaces become `+`, and
 *      most punctuation is percent-encoded. We use Node's
 *      `URLSearchParams.toString()` to match this exactly.
 *   5. If a passphrase is set on the merchant account, it is appended as
 *      `&passphrase=<urlencoded>` AFTER the sorted params.
 *
 * Verification re-runs (1)..(5) on the received params and compares case-
 * insensitively against the supplied `signature`.
 *
 * Heavy unit-tested in signature.util.spec.ts against the published vectors.
 */

export type SignableParams = Record<string, string | number | undefined | null>;

/** Build the canonical signature string for a set of form params. Exported for
 * unit tests; payment code calls signParams() / verifySignature(). */
export function buildSignatureString(params: SignableParams, passphrase?: string): string {
  const entries: Array<[string, string]> = [];
  for (const [key, raw] of Object.entries(params)) {
    if (key === 'signature') continue;
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    if (value.length === 0) continue;
    entries.push([key, value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // URLSearchParams produces application/x-www-form-urlencoded output: spaces
  // → `+`, full RFC 1738 encoding for punctuation — matches PHP's urlencode().
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.append(k, v);
  let signatureString = sp.toString();

  if (passphrase && passphrase.length > 0) {
    const ppSp = new URLSearchParams();
    ppSp.append('passphrase', passphrase);
    signatureString += signatureString.length > 0 ? '&' : '';
    signatureString += ppSp.toString();
  }

  return signatureString;
}

/** Compute the MD5 signature for the given params. */
export function signParams(params: SignableParams, passphrase?: string): string {
  const signatureString = buildSignatureString(params, passphrase);
  return createHash('md5').update(signatureString).digest('hex');
}

/** Constant-time-ish hex comparison; sufficient for an MD5 cheap-equality
 *  guard (the real attacker-cost barrier here is PayFast's pre-shared
 *  passphrase, not signature-length timing). */
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a PayFast signature. `params` should be the raw form fields as
 * received (without the `signature` field itself; it can be left in — this
 * helper strips it). `received` is the signature field value from the request.
 */
export function verifySignature(
  params: SignableParams,
  received: string,
  passphrase?: string,
): boolean {
  if (!received) return false;
  const expected = signParams(params, passphrase);
  return safeEquals(expected.toLowerCase(), received.toLowerCase());
}
