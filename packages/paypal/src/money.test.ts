import { describe, expect, it } from 'vitest';
import { fromDecimalString, minorUnitsFor, toDecimalString } from './money';

// Deterministic generator: no Math.random in SBX code outside packages/runtime.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

describe('toDecimalString', () => {
  it('writes integer minor units as exact decimal strings', () => {
    expect(toDecimalString({ currency: 'USD', minor: 250 }, 2)).toBe('2.50');
    expect(toDecimalString({ currency: 'USD', minor: 0 }, 2)).toBe('0.00');
    expect(toDecimalString({ currency: 'USD', minor: 5 }, 2)).toBe('0.05');
    expect(toDecimalString({ currency: 'USD', minor: 10 }, 2)).toBe('0.10');
    expect(toDecimalString({ currency: 'USD', minor: 100000 }, 2)).toBe('1000.00');
    expect(toDecimalString({ currency: 'JPY', minor: 500 }, 0)).toBe('500');
    expect(toDecimalString({ currency: 'KWD', minor: 1005 }, 3)).toBe('1.005');
    expect(toDecimalString({ currency: 'KWD', minor: 7 }, 3)).toBe('0.007');
  });

  it('refuses a minor value that is not a non-negative safe integer', () => {
    for (const minor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => toDecimalString({ currency: 'USD', minor }, 2), String(minor)).toThrow();
    }
  });
});

describe('fromDecimalString', () => {
  it('parses exact decimals', () => {
    expect(fromDecimalString('2.50', 'USD', 2)).toEqual({
      ok: true,
      value: { currency: 'USD', minor: 250 },
    });
    expect(fromDecimalString('0.1', 'USD', 2)).toEqual({
      ok: true,
      value: { currency: 'USD', minor: 10 },
    });
    expect(fromDecimalString('5', 'USD', 2)).toEqual({
      ok: true,
      value: { currency: 'USD', minor: 500 },
    });
    expect(fromDecimalString('500', 'JPY', 0)).toEqual({
      ok: true,
      value: { currency: 'JPY', minor: 500 },
    });
    expect(fromDecimalString('0.00', 'USD', 2)).toEqual({
      ok: true,
      value: { currency: 'USD', minor: 0 },
    });
  });

  it('"2.505" and "1e2" and "-1.00" refused', () => {
    for (const v of ['2.505', '1e2', '-1.00']) {
      expect(fromDecimalString(v, 'USD', 2), v).toEqual({ ok: false, error: 'bad_amount' });
    }
  });

  it('refuses every other non-plain-decimal text', () => {
    const bad = [
      '',
      ' ',
      '+1.00',
      '1.00 ',
      ' 1.00',
      '1,00',
      '1.',
      '.5',
      '0x10',
      'NaN',
      'Infinity',
      '1_000',
      '1.0e1',
      '１.00',
      '2.500', // more decimals than minor_units, even when the extra digit is zero
      '100.00', // JPY has no decimals (checked below with minor_units 0)
      '99999999999999999999.00',
      '90071992547409.92', // 2**53 minor units: not a safe integer
    ];
    for (const v of bad) {
      expect(fromDecimalString(v, 'USD', 2), JSON.stringify(v)).toEqual({
        ok: false,
        error: 'bad_amount',
      });
    }
    expect(fromDecimalString('100.00', 'JPY', 0)).toEqual({ ok: false, error: 'bad_amount' });
    expect(fromDecimalString('1.0', 'JPY', 0)).toEqual({ ok: false, error: 'bad_amount' });
  });

  it('refuses a currency that is not three upper-case letters', () => {
    for (const c of ['usd', 'US', 'USDX', '', 'U1D']) {
      expect(fromDecimalString('1.00', c, 2), c).toEqual({ ok: false, error: 'bad_amount' });
    }
  });
});

describe('minorUnitsFor', () => {
  it('knows the zero-decimal and default currencies', () => {
    expect(minorUnitsFor('USD')).toBe(2);
    expect(minorUnitsFor('EUR')).toBe(2);
    expect(minorUnitsFor('GBP')).toBe(2);
    expect(minorUnitsFor('JPY')).toBe(0);
    expect(minorUnitsFor('HUF')).toBe(0);
    expect(minorUnitsFor('TWD')).toBe(0);
  });
});

describe('money', () => {
  it('money round trip property, 10k cases, minor_units 0 and 2', () => {
    const next = lcg(20261022);
    for (let i = 0; i < 10_000; i += 1) {
      // spans 0 .. 2^42, with edge sizes mixed in (small values hit padding)
      const minor = i % 4 === 0 ? next() % 1000 : next() * 1024 + (next() % 1024);
      for (const mu of [0, 2] as const) {
        const text = toDecimalString({ currency: 'USD', minor }, mu);
        expect(text).toMatch(mu === 0 ? /^\d+$/ : /^\d+\.\d{2}$/);
        const back = fromDecimalString(text, 'USD', mu);
        expect(back).toEqual({ ok: true, value: { currency: 'USD', minor } });
      }
    }
  });

  it('three-decimal round trip', () => {
    const next = lcg(7);
    for (let i = 0; i < 1000; i += 1) {
      const minor = next();
      const t = toDecimalString({ currency: 'KWD', minor }, 3);
      expect(fromDecimalString(t, 'KWD', 3)).toEqual({
        ok: true,
        value: { currency: 'KWD', minor },
      });
    }
  });
});
