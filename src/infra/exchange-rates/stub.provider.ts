import { Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@prisma/client';
import { STUB_BASE_CURRENCY, STUB_RATES_FROM_ZAR } from '../../../prisma/seeds/exchange-rates';
import type { ExchangeRatesProvider, ProviderQuote } from './exchange-rates.provider';

/**
 * Returns seeded mid-market reference rates from prisma/seeds/exchange-rates.ts.
 * Used when EXCHANGE_RATE_PROVIDER_KEY is absent (business-rules §8.4). The
 * stub never crashes; the engine and the FX cron pipeline still work end-to-end
 * locally and in CI.
 */
@Injectable()
export class StubExchangeRatesProvider implements ExchangeRatesProvider {
  readonly name = 'stub' as const;
  private readonly logger = new Logger(StubExchangeRatesProvider.name);

  async fetchRates(): Promise<ProviderQuote[]> {
    const now = new Date();
    this.logger.debug(`Stub FX: emitting ${STUB_RATES_FROM_ZAR.length} ZAR-anchored rates`);
    return STUB_RATES_FROM_ZAR.map(({ toCurrency, rate }) => ({
      fromCurrency: STUB_BASE_CURRENCY as Currency,
      toCurrency: toCurrency as Currency,
      rate,
      asOf: now,
    }));
  }
}
