import { describe, expect, it } from 'vitest';
import { convert } from './index';
import type { FxRates } from './index';

// MC2-L4 (D-084 item 4, D-085). Exact integer arithmetic on minor units: half away from zero, cross rates
// from the two EUR rates of one date, a rate usable up to 7 days old, never above MAX_SAFE_INTEGER.
const AT = new Date('2026-11-04T10:00:00Z');
const rates = (over: Partial<FxRates> = {}): FxRates => ({
  date: '2026-11-03',
  eur_usd: '1.15',
  eur_gbp: '0.87',
  fetched_at: '2026-11-03T16:00:00.000Z',
  age_ms: 18 * 3600_000,
  source: 'ecb',
  ...over,
});

describe('convert', () => {
  it('EUR to USD multiplies by the EUR/USD rate and says it is about', () => {
    expect(convert({ minor: 1000, from: 'EUR', to: 'USD', rates: rates(), at: AT })).toEqual({
      minor: 1150,
      rate_date: '2026-11-03',
      rate: 1.15,
      approx: true,
    });
  });
  it('1000 USD minor to EUR divides by the EUR/USD rate (869.565 rounds to 870)', () => {
    const r = convert({ minor: 1000, from: 'USD', to: 'EUR', rates: rates(), at: AT })!;
    expect(r.minor).toBe(870);
    expect(r.rate_date).toBe('2026-11-03');
    expect(r.rate).toBeCloseTo(1 / 1.15, 9);
    expect(r.approx).toBe(true);
  });
  it('EUR to GBP and GBP to EUR use the EUR/GBP rate', () => {
    expect(convert({ minor: 1000, from: 'EUR', to: 'GBP', rates: rates(), at: AT })!.minor).toBe(
      870,
    );
    expect(convert({ minor: 870, from: 'GBP', to: 'EUR', rates: rates(), at: AT })!.minor).toBe(
      1000,
    );
  });
  it('GBP to USD is a cross rate from the two EUR rates of the same date (1000 * 1.15 / 0.87 = 1321.84)', () => {
    const r = convert({ minor: 1000, from: 'GBP', to: 'USD', rates: rates(), at: AT })!;
    expect(r.minor).toBe(1322);
    expect(r.rate).toBeCloseTo(1.15 / 0.87, 9);
    expect(r.rate_date).toBe('2026-11-03');
    const back = convert({ minor: 1000, from: 'USD', to: 'GBP', rates: rates(), at: AT })!;
    expect(back.minor).toBe(757);
    expect(back.rate).toBeCloseTo(0.87 / 1.15, 9);
  });
  it('same currency is the identity: the same amount, rate 1, not approximate, even with no rates', () => {
    for (const c of ['USD', 'EUR', 'GBP'] as const) {
      expect(convert({ minor: 1234, from: c, to: c, rates: rates(), at: AT })).toEqual({
        minor: 1234,
        rate_date: null,
        rate: 1,
        approx: false,
      });
      expect(convert({ minor: 1234, from: c, to: c, rates: null, at: AT })!.minor).toBe(1234);
    }
  });
  it('rounds half away from zero to the nearest minor unit (table of six)', () => {
    const half = rates({ eur_usd: '1.5' });
    const two = rates({ eur_usd: '2' });
    const table: [string, number, 'EUR' | 'USD', 'EUR' | 'USD', FxRates, number][] = [
      ['1.5 up', 1, 'EUR', 'USD', half, 2],
      ['4.5 up', 3, 'EUR', 'USD', half, 5],
      ['-1.5 away from zero', -1, 'EUR', 'USD', half, -2],
      ['-4.5 away from zero', -3, 'EUR', 'USD', half, -5],
      ['2.5 up, not to even', 5, 'USD', 'EUR', two, 3],
      ['-2.5 away from zero', -5, 'USD', 'EUR', two, -3],
    ];
    for (const [name, minor, from, to, r, want] of table)
      expect(convert({ minor, from, to, rates: r, at: AT })!.minor, name).toBe(want);
  });
  it('zero stays zero and a result under half a unit rounds to zero', () => {
    expect(convert({ minor: 0, from: 'EUR', to: 'USD', rates: rates(), at: AT })!.minor).toBe(0);
    expect(
      convert({ minor: 1, from: 'EUR', to: 'GBP', rates: rates({ eur_gbp: '0.4' }), at: AT })!
        .minor,
    ).toBe(0);
  });
  it('is exact where floating point is not: 100 * 1.005 is 100.5 and rounds up to 101', () => {
    // As a float, 100 * 1.005 is 100.49999999999999 and would round down to 100.
    expect(
      convert({ minor: 100, from: 'EUR', to: 'USD', rates: rates({ eur_usd: '1.005' }), at: AT })!
        .minor,
    ).toBe(101);
    expect(
      convert({ minor: 50, from: 'EUR', to: 'USD', rates: rates({ eur_usd: '1.005' }), at: AT })!
        .minor,
    ).toBe(50);
  });
  it('a rate dated up to 7 days before `at` is usable; 8 days is not', () => {
    const r = rates({ date: '2026-11-03' });
    expect(
      convert({
        minor: 100,
        from: 'EUR',
        to: 'USD',
        rates: r,
        at: new Date('2026-11-10T23:59:59Z'),
      }),
    ).not.toBeNull();
    expect(
      convert({
        minor: 100,
        from: 'EUR',
        to: 'USD',
        rates: r,
        at: new Date('2026-11-11T00:00:00Z'),
      }),
    ).toBeNull();
    expect(
      convert({
        minor: 100,
        from: 'GBP',
        to: 'USD',
        rates: r,
        at: new Date('2026-12-01T00:00:00Z'),
      }),
    ).toBeNull();
  });
  it('no rate at all gives null for every pair across currencies', () => {
    expect(convert({ minor: 100, from: 'EUR', to: 'USD', rates: null, at: AT })).toBeNull();
    expect(convert({ minor: 100, from: 'GBP', to: 'USD', rates: null, at: AT })).toBeNull();
  });
  it('an unusable stored rate gives null (empty, zero, negative or not a number)', () => {
    for (const bad of ['', '0', '-1.2', 'NaN', 'abc', '1e3']) {
      expect(
        convert({ minor: 100, from: 'EUR', to: 'USD', rates: rates({ eur_usd: bad }), at: AT }),
        bad,
      ).toBeNull();
      expect(
        convert({ minor: 100, from: 'GBP', to: 'EUR', rates: rates({ eur_gbp: bad }), at: AT }),
        bad,
      ).toBeNull();
    }
  });
  it('a result above Number.MAX_SAFE_INTEGER, or an input that is not a safe integer, gives null', () => {
    expect(
      convert({ minor: Number.MAX_SAFE_INTEGER, from: 'EUR', to: 'USD', rates: rates(), at: AT }),
    ).toBeNull();
    expect(
      convert({ minor: Number.MAX_SAFE_INTEGER, from: 'USD', to: 'EUR', rates: rates(), at: AT }),
    ).not.toBeNull();
    expect(
      convert({ minor: -Number.MAX_SAFE_INTEGER, from: 'EUR', to: 'USD', rates: rates(), at: AT }),
    ).toBeNull();
    expect(convert({ minor: 2 ** 53, from: 'USD', to: 'EUR', rates: rates(), at: AT })).toBeNull();
    expect(convert({ minor: 2 ** 53, from: 'USD', to: 'USD', rates: rates(), at: AT })).toBeNull();
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        convert({ minor: bad, from: 'EUR', to: 'USD', rates: rates(), at: AT }),
        String(bad),
      ).toBeNull();
    }
  });
  it('a currency outside USD, EUR and GBP gives null', () => {
    expect(
      convert({ minor: 100, from: 'JPY' as never, to: 'USD', rates: rates(), at: AT }),
    ).toBeNull();
    expect(
      convert({ minor: 100, from: 'EUR', to: 'XAU' as never, rates: rates(), at: AT }),
    ).toBeNull();
  });
  it('a bad `at` gives null', () => {
    expect(
      convert({ minor: 100, from: 'EUR', to: 'USD', rates: rates(), at: new Date(Number.NaN) }),
    ).toBeNull();
  });
});
