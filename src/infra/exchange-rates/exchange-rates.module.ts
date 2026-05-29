import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { EXCHANGE_RATES_PROVIDER, type ExchangeRatesProvider } from './exchange-rates.provider';
import { OpenExchangeRatesProvider } from './open-exchange-rates.provider';
import { StubExchangeRatesProvider } from './stub.provider';

/**
 * Provider factory (business-rules §8.4): picks the live Open Exchange Rates
 * provider when EXCHANGE_RATE_PROVIDER_KEY is set, else returns the stub.
 * The choice is bound at module-init time; restart to swap providers.
 */
@Global()
@Module({
  providers: [
    OpenExchangeRatesProvider,
    StubExchangeRatesProvider,
    {
      provide: EXCHANGE_RATES_PROVIDER,
      useFactory: (
        config: AppConfig,
        live: OpenExchangeRatesProvider,
        stub: StubExchangeRatesProvider,
      ): ExchangeRatesProvider => (config.fx.liveProviderEnabled ? live : stub),
      inject: [APP_CONFIG, OpenExchangeRatesProvider, StubExchangeRatesProvider],
    },
  ],
  exports: [EXCHANGE_RATES_PROVIDER],
})
export class ExchangeRatesModule {}
