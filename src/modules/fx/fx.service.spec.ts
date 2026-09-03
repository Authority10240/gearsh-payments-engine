import { Prisma } from '@prisma/client';
import { roundHalfToEven } from './fx.service';

/**
 * Unit tests for the centralised half-to-even rounding helper used by
 * convertCurrency (business-rules §8.7). Edge cases: exact .5 ties round to
 * even; .5+ rounds up; .5- rounds down; negative numbers symmetric.
 */
describe('roundHalfToEven', () => {
  it('rounds non-half values to nearest', () => {
    expect(roundHalfToEven(new Prisma.Decimal('123.4'))).toBe(123n);
    expect(roundHalfToEven(new Prisma.Decimal('123.6'))).toBe(124n);
  });

  it('rounds .5 ties to the nearest EVEN integer', () => {
    expect(roundHalfToEven(new Prisma.Decimal('2.5'))).toBe(2n);
    expect(roundHalfToEven(new Prisma.Decimal('3.5'))).toBe(4n);
    expect(roundHalfToEven(new Prisma.Decimal('4.5'))).toBe(4n);
    expect(roundHalfToEven(new Prisma.Decimal('5.5'))).toBe(6n);
    expect(roundHalfToEven(new Prisma.Decimal('0.5'))).toBe(0n);
  });

  it('handles negative numbers symmetrically', () => {
    expect(roundHalfToEven(new Prisma.Decimal('-2.5'))).toBe(-2n);
    expect(roundHalfToEven(new Prisma.Decimal('-3.5'))).toBe(-4n);
    expect(roundHalfToEven(new Prisma.Decimal('-123.6'))).toBe(-124n);
  });

  it('handles very large magnitudes (multi-currency at scale)', () => {
    expect(roundHalfToEven(new Prisma.Decimal('1234567890123456.5'))).toBe(1234567890123456n);
    expect(roundHalfToEven(new Prisma.Decimal('1234567890123457.5'))).toBe(1234567890123458n);
  });

  it('passes through integer values unchanged', () => {
    expect(roundHalfToEven(new Prisma.Decimal('100'))).toBe(100n);
    expect(roundHalfToEven(new Prisma.Decimal('-100'))).toBe(-100n);
    expect(roundHalfToEven(new Prisma.Decimal('0'))).toBe(0n);
  });

  it('rounds boundaries just above and below .5', () => {
    expect(roundHalfToEven(new Prisma.Decimal('2.4999999'))).toBe(2n);
    expect(roundHalfToEven(new Prisma.Decimal('2.5000001'))).toBe(3n);
    expect(roundHalfToEven(new Prisma.Decimal('-2.5000001'))).toBe(-3n);
  });
});

// ── PAY-008: admin override precedence ──────────────────────────────────

import { FxService } from './fx.service';
import { AppException } from '../../common/problem/app-exception';
import type { PrismaService } from '../../infra/prisma/prisma.service';

describe('FxService overrides (PAY-008)', () => {
  const prisma = {
    fxRateOverride: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    exchangeRate: { findFirst: jest.fn() },
  } as unknown as PrismaService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any;
  const service = new FxService(
    { business: {} } as never,
    { name: 'stub', fetchRates: jest.fn() } as never,
    prisma,
  );

  beforeEach(() => jest.clearAllMocks());

  it('convertCurrency prefers a pinned override over provider rows', async () => {
    p.fxRateOverride.findUnique.mockResolvedValue({
      rate: new Prisma.Decimal('20'),
      updatedAt: new Date('2026-09-03T00:00:00Z'),
    });
    const out = await service.convertCurrency(100n, 'USD', 'ZAR');
    expect(out.rate).toBe('20');
    expect(out.amountCents).toBe(2000n);
    expect(p.exchangeRate.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the latest exchange_rates row when no override', async () => {
    p.fxRateOverride.findUnique.mockResolvedValue(null);
    p.exchangeRate.findFirst.mockResolvedValue({
      rate: new Prisma.Decimal('18.5'),
      asOf: new Date('2026-09-02T00:00:00Z'),
    });
    const out = await service.convertCurrency(100n, 'USD', 'ZAR');
    expect(out.rate).toBe('18.5');
    expect(out.amountCents).toBe(1850n);
  });

  it('putOverride rejects self-pairs and non-positive rates', async () => {
    await expect(service.putOverride('ZAR', 'ZAR', '1')).rejects.toBeInstanceOf(AppException);
    await expect(service.putOverride('USD', 'ZAR', '0')).rejects.toBeInstanceOf(AppException);
    expect(p.fxRateOverride.upsert).not.toHaveBeenCalled();
  });
});
