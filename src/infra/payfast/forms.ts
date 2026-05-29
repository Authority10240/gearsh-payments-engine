import { signParams, type SignableParams } from './signature.util';

/**
 * Build the signed PayFast form parameters used to redirect the client to the
 * PayFast hosted checkout (gearsh-payments-engine.md §PayFast integration
 * "Payment initiation flow"). Only the fields documented in the PayFast
 * Process URL spec are included; `signature` is appended last after computing
 * MD5(sorted + passphrase).
 *
 * `amountMajorUnits` is the ZAR amount in MAJOR units (Rand), as required by
 * PayFast — the intent service supplies it from `zar_amount_cents_locked` / 100
 * formatted to two decimals.
 */
export interface BuildPayFastFormInput {
  merchantId: string;
  merchantKey: string;
  passphrase?: string;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  /** Merchant-side payment reference (= payment intent id). */
  mPaymentId: string;
  amountMajorUnits: string;
  itemName: string;
  itemDescription?: string;
  /** Optional buyer details (PayFast displays them on the hosted page). */
  nameFirst?: string;
  nameLast?: string;
  emailAddress?: string;
}

export interface PayFastFormParams {
  [key: string]: string;
}

export function buildPayFastForm(input: BuildPayFastFormInput): PayFastFormParams {
  const params: SignableParams = {
    merchant_id: input.merchantId,
    merchant_key: input.merchantKey,
    return_url: input.returnUrl,
    cancel_url: input.cancelUrl,
    notify_url: input.notifyUrl,
    m_payment_id: input.mPaymentId,
    amount: input.amountMajorUnits,
    item_name: input.itemName,
    item_description: input.itemDescription,
    name_first: input.nameFirst,
    name_last: input.nameLast,
    email_address: input.emailAddress,
  };

  const signature = signParams(params, input.passphrase);

  const out: PayFastFormParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  out.signature = signature;
  return out;
}

/** Major-unit string with two decimals, matching PayFast's `amount` format. */
export function centsToMajorString(amountCents: bigint | number): string {
  const cents = typeof amountCents === 'bigint' ? amountCents : BigInt(amountCents);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const major = abs / 100n;
  const minor = abs % 100n;
  return `${sign}${major}.${minor.toString().padStart(2, '0')}`;
}
