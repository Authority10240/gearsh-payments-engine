import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Currency, ExchangeRateSource, Prisma } from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import {
  EXCHANGE_RATES_PROVIDER,
  type ExchangeRatesProvider,
  type ProviderQuote,
} from '../../infra/exchange-rates/exchange-rates.provider';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface ConvertedAmount {
  amountCents: bigint;
  fromCurrency: Currency;
  toCurrency: Currency;
  /** Rate used (1 unit of fromCurrency = `rate` units of toCurrency). */
  rate: string;
  /** Timestamp of the rate row used. */
  rateAsOf: Date;
}

const SUPPORTED: Currency[] = ['ZAR', 'USD', 'GBP', 'NGN', 'KES', 'GHS', 'AUD', 'CAD'];

/**
 * Foreign-exchange service — owns the daily rate refresh, the cached lookup,
 * the conversion helper, and the centralised bankers'-rounding (half-to-even)
 * rule (business-rules §8.4, §8.6, §8.7).
 *
 * The conversion helper is THE single entry point — every caller in the
 * engine (intent creation, intent lock, refund preview) uses convertCurrency()
 * so rounding behaviour is enforced once across the platform.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EXCHANGE_RATES_PROVIDER) private readonly provider: ExchangeRatesProvider,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Daily 02:00 SAST cron (business-rules §8.4). Pulls rates for the 8
   * supported currencies and upserts into `exchange_rates`. Africa/Johannesburg
   * is UTC+2 year-round → 00:00 UTC == 02:00 SAST.
   */
  @Cron('0 0 * * *', { timeZone: 'Africa/Johannesburg', name: 'fx-rates-refresh' })
  async refresh(): Promise<{ written: number }> {
    try {
      const quotes = await this.provider.fetchRates();
      const source: ExchangeRateSource =
        this.provider.name === 'open_exchange_rates' ? 'OPEN_EXCHANGE_RATES' : 'STUB';
      const expanded = this.expandPairs(quotes);
      let written = 0;
      for (const q of expanded) {
        await this.prisma.exchangeRate.upsert({
          where: {
            fromCurrency_toCurrency_asOf: {
              fromCurrency: q.fromCurrency,
              toCurrency: q.toCurrency,
              asOf: q.asOf,
            },
          },
          update: { rate: new Prisma.Decimal(q.rate), source },
          create: {
            fromCurrency: q.fromCurrency,
            toCurrency: q.toCurrency,
            rate: new Prisma.Decimal(q.rate),
            asOf: q.asOf,
            source,
          },
        });
        written += 1;
      }
      this.logger.log(`FX refresh complete — ${written} rate rows (source=${source})`);
      return { written };
    } catch (err) {
      this.logger.warn(`FX refresh failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Cross-currency conversion (business-rules §8.7 — bankers'/half-to-even
   * rounding). The single helper every caller MUST use.
   *
   * Throws FX_RATE_UNAVAILABLE when no cached rate row exists for the
   * (from, to) pair at-or-before `asOf` (default: now).
   */
  async convertCurrency(
    amountCents: bigint | number,
    fromCurrency: Currency,
    toCurrency: Currency,
    asOf?: Date,
  ): Promise<ConvertedAmount> {
    this.assertSupported(fromCurrency);
    this.assertSupported(toCurrency);

    const amt = typeof amountCents === 'bigint' ? amountCents : BigInt(amountCents);
    if (fromCurrency === toCurrency) {
      return {
        amountCents: amt,
        fromCurrency,
        toCurrency,
        rate: '1',
        rateAsOf: asOf ?? new Date(),
      };
    }

    const at = asOf ?? new Date();

    // PAY-008: an admin-pinned override beats any provider/seed row for the
    // pair until it is deleted (§9.12 FX overrides).
    const override = await this.prisma.fxRateOverride.findUnique({
      where: { fromCurrency_toCurrency: { fromCurrency, toCurrency } },
    });

    const effective = override
      ? { rate: override.rate, asOf: override.updatedAt }
      : await this.prisma.exchangeRate.findFirst({
          where: { fromCurrency, toCurrency, asOf: { lte: at } },
          orderBy: { asOf: 'desc' },
        });
    if (!effective) {
      throw new AppException(ErrorCode.FX_RATE_UNAVAILABLE, {
        detail: `No cached rate for ${fromCurrency} → ${toCurrency} at or before ${at.toISOString()}.`,
      });
    }

    // Decimal math via Prisma.Decimal for the multiplication; bankers' rounding
    // is then applied to the resulting minor units.
    const product = new Prisma.Decimal(amt.toString()).mul(effective.rate);
    const converted = roundHalfToEven(product);

    return {
      amountCents: converted,
      fromCurrency,
      toCurrency,
      rate: effective.rate.toString(),
      rateAsOf: effective.asOf,
    };
  }

  // ── PAY-008: admin FX overrides ──────────────────────────────────────

  async listOverrides() {
    const rows = await this.prisma.fxRateOverride.findMany({
      orderBy: [{ fromCurrency: 'asc' }, { toCurrency: 'asc' }],
    });
    return rows.map((r) => ({
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      rate: r.rate.toString(),
      updatedAt: r.updatedAt,
    }));
  }

  async putOverride(
    fromCurrency: Currency,
    toCurrency: Currency,
    rate: string,
    updatedBy?: string,
  ) {
    this.assertSupported(fromCurrency);
    this.assertSupported(toCurrency);
    if (fromCurrency === toCurrency) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Cannot override a currency against itself.',
      });
    }
    const dec = new Prisma.Decimal(rate);
    if (dec.lte(0)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Rate must be positive.',
      });
    }
    const row = await this.prisma.fxRateOverride.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency, toCurrency } },
      update: { rate: dec, updatedBy },
      create: { fromCurrency, toCurrency, rate: dec, updatedBy },
    });
    return {
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: row.rate.toString(),
      updatedAt: row.updatedAt,
    };
  }

  async deleteOverride(fromCurrency: Currency, toCurrency: Currency): Promise<void> {
    await this.prisma.fxRateOverride.deleteMany({ where: { fromCurrency, toCurrency } });
  }

  /** Read all latest rates anchored on `base`. Used by GET /v1/rates. */
  async listLatestRates(
    base: Currency,
  ): Promise<{ toCurrency: Currency; rate: string; asOf: Date; source: ExchangeRateSource }[]> {
    this.assertSupported(base);
    const out: { toCurrency: Currency; rate: string; asOf: Date; source: ExchangeRateSource }[] =
      [];
    for (const to of SUPPORTED) {
      const row = await this.prisma.exchangeRate.findFirst({
        where: { fromCurrency: base, toCurrency: to },
        orderBy: { asOf: 'desc' },
      });
      if (!row) continue;
      out.push({
        toCurrency: row.toCurrency,
        rate: row.rate.toString(),
        asOf: row.asOf,
        source: row.source,
      });
    }
    return out;
  }

  /**
   * Given anchor quotes (e.g. ZAR → X), derive the inverse + cross pairs so
   * convertCurrency() can answer any pair in the supported set. Inverses use
   * 1 / rate; cross pairs (A→B with A != base) use rate(base→B) / rate(base→A).
   */
  private expandPairs(anchor: ProviderQuote[]): ProviderQuote[] {
    if (anchor.length === 0) return [];
    const base = anchor[0].fromCurrency;
    const sameAsOf = anchor[0].asOf;
    const byTo = new Map<Currency, number>();
    for (const q of anchor) byTo.set(q.toCurrency, q.rate);

    const out: ProviderQuote[] = [];
    for (const a of SUPPORTED) {
      const aFromBase = a === base ? 1 : byTo.get(a);
      if (!aFromBase || aFromBase <= 0) continue;
      for (const b of SUPPORTED) {
        const bFromBase = b === base ? 1 : byTo.get(b);
        if (!bFromBase || bFromBase <= 0) continue;
        const rate = bFromBase / aFromBase;
        out.push({ fromCurrency: a, toCurrency: b, rate, asOf: sameAsOf });
      }
    }
    return out;
  }

  private assertSupported(currency: Currency): void {
    if (!SUPPORTED.includes(currency)) {
      throw new AppException(ErrorCode.CURRENCY_UNSUPPORTED, {
        detail: `${currency} is not a supported currency.`,
      });
    }
  }
}

/**
 * Round a Decimal to the nearest integer using bankers' (half-to-even)
 * rounding. Centralised here (business-rules §8.7). Exported for unit tests.
 */
export function roundHalfToEven(value: Prisma.Decimal): bigint {
  const isNeg = value.isNegative();
  const abs = isNeg ? value.neg() : value;
  const floor = abs.floor();
  const frac = abs.minus(floor);
  const half = new Prisma.Decimal('0.5');

  let rounded: Prisma.Decimal;
  if (frac.lt(half)) {
    rounded = floor;
  } else if (frac.gt(half)) {
    rounded = floor.plus(1);
  } else {
    // Exactly .5 — round to even.
    const floorIsEven = floor.modulo(2).isZero();
    rounded = floorIsEven ? floor : floor.plus(1);
  }
  const out = isNeg ? rounded.neg() : rounded;
  return BigInt(out.toFixed(0));
}
