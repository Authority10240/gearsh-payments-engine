/**
 * Sane mid-market reference rates used by the StubExchangeRatesProvider when
 * EXCHANGE_RATE_PROVIDER_KEY is absent (business-rules §8.4: degrade-on-
 * missing-creds, same spirit as the data engine's Firebase/Maps stubs). Base
 * currency = ZAR; the rate is "1 ZAR = N of `toCurrency`". Symmetric inverses
 * are derived at write-time so /v1/rates can answer any base.
 *
 * These values are NOT a live FX feed — they exist only so dev/CI can exercise
 * the FX pipeline end-to-end without API keys. Real refresh runs daily 02:00
 * SAST via OpenExchangeRatesProvider in production.
 */
export interface SeedRate {
  toCurrency: 'ZAR' | 'USD' | 'GBP' | 'NGN' | 'KES' | 'GHS' | 'AUD' | 'CAD';
  rate: number;
}

export const STUB_BASE_CURRENCY = 'ZAR' as const;

/** 1 ZAR ≈ N of toCurrency (rough mid-2026 reference values; replace via the
 *  live OXR refresh in prod). The base→base row (ZAR→ZAR = 1) is asserted by
 *  the seeder so the conversion helper has a trivial identity case. */
export const STUB_RATES_FROM_ZAR: SeedRate[] = [
  { toCurrency: 'ZAR', rate: 1 },
  { toCurrency: 'USD', rate: 0.054 },
  { toCurrency: 'GBP', rate: 0.043 },
  { toCurrency: 'NGN', rate: 86 },
  { toCurrency: 'KES', rate: 7.0 },
  { toCurrency: 'GHS', rate: 0.78 },
  { toCurrency: 'AUD', rate: 0.082 },
  { toCurrency: 'CAD', rate: 0.075 },
];
