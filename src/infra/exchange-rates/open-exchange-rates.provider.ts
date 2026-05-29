import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { Currency } from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import type { ExchangeRatesProvider, ProviderQuote } from './exchange-rates.provider';

const SUPPORTED: Currency[] = ['ZAR', 'USD', 'GBP', 'NGN', 'KES', 'GHS', 'AUD', 'CAD'];

/**
 * Real implementation backed by Open Exchange Rates (business-rules §8.4).
 * OXR returns rates anchored on USD on the free tier; we re-anchor on ZAR
 * since ZAR is the platform settlement currency (and what the daily refresh
 * job stores per-pair).
 *
 * Degrade-on-missing-creds: if URL/key are absent we DO NOT register this
 * provider — the factory falls back to the stub. This method should therefore
 * never be called without creds; if it is, it throws FX_RATE_UNAVAILABLE.
 */
@Injectable()
export class OpenExchangeRatesProvider implements ExchangeRatesProvider {
  readonly name = 'open_exchange_rates' as const;
  private readonly logger = new Logger(OpenExchangeRatesProvider.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async fetchRates(): Promise<ProviderQuote[]> {
    const url = this.config.fx.providerUrl;
    const appId = this.config.fx.providerKey;
    if (!url || !appId) {
      throw new AppException(ErrorCode.FX_RATE_UNAVAILABLE, {
        detail: 'Open Exchange Rates is not configured.',
      });
    }

    const endpoint = `${url.replace(/\/$/, '')}/latest.json`;
    let payload: { base: string; rates: Record<string, number>; timestamp: number };
    try {
      const res = await axios.get<{
        base: string;
        rates: Record<string, number>;
        timestamp: number;
      }>(endpoint, { params: { app_id: appId, symbols: SUPPORTED.join(',') }, timeout: 15_000 });
      payload = res.data;
    } catch (err) {
      this.logger.warn(`OXR fetch failed: ${(err as Error).message}`);
      throw new AppException(ErrorCode.FX_RATE_UNAVAILABLE, {
        detail: 'Open Exchange Rates request failed.',
      });
    }

    const baseRates = payload.rates;
    if (!baseRates || typeof baseRates !== 'object') {
      throw new AppException(ErrorCode.FX_RATE_UNAVAILABLE, {
        detail: 'Open Exchange Rates returned no rates payload.',
      });
    }

    // Re-anchor on ZAR: rate(ZAR→X) = rate(USD→X) / rate(USD→ZAR).
    const usdToZar = baseRates.ZAR;
    if (!usdToZar || usdToZar <= 0) {
      throw new AppException(ErrorCode.FX_RATE_UNAVAILABLE, {
        detail: 'OXR payload missing a usable USD→ZAR rate.',
      });
    }

    const asOf = new Date((payload.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
    const quotes: ProviderQuote[] = [];
    for (const to of SUPPORTED) {
      const usdToTo = to === 'USD' ? 1 : baseRates[to];
      if (!usdToTo || usdToTo <= 0) continue;
      const zarToTo = to === 'ZAR' ? 1 : usdToTo / usdToZar;
      quotes.push({ fromCurrency: 'ZAR', toCurrency: to, rate: zarToTo, asOf });
    }
    return quotes;
  }
}
