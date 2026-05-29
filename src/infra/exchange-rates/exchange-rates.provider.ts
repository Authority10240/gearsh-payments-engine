import type { Currency } from '@prisma/client';

/** Single FX quote returned by a provider. `asOf` is when the quote was
 *  generated upstream; the FX service writes it into `exchange_rates.as_of`. */
export interface ProviderQuote {
  fromCurrency: Currency;
  toCurrency: Currency;
  /** Mid-market rate: 1 unit of fromCurrency == `rate` units of toCurrency. */
  rate: number;
  asOf: Date;
}

/**
 * Interface for FX-rate providers (business-rules §8.4: Open Exchange Rates
 * with a stub fallback). Implementations MUST return rates for every supported
 * currency pair (or at least one base anchor; the FX service derives inverses).
 */
export interface ExchangeRatesProvider {
  readonly name: 'open_exchange_rates' | 'stub';
  /** Fetch fresh quotes anchored on ZAR (the platform's settlement currency). */
  fetchRates(): Promise<ProviderQuote[]>;
}

export const EXCHANGE_RATES_PROVIDER = 'EXCHANGE_RATES_PROVIDER';
