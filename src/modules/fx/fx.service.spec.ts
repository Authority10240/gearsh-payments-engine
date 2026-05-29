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
