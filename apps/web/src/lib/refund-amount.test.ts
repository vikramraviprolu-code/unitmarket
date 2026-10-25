import { describe, expect, it } from 'vitest';
import { parseAmount } from './refund-amount';

describe('parseAmount', () => {
  it('empty text is the rest', () => {
    expect(parseAmount('', 2)).toBeNull();
    expect(parseAmount('   ', 2)).toBeNull();
  });
  it('reads whole and decimal amounts into minor units', () => {
    expect(parseAmount('1.50', 2)).toBe(150);
    expect(parseAmount('1.5', 2)).toBe(150);
    expect(parseAmount('0.05', 2)).toBe(5);
    expect(parseAmount('12', 2)).toBe(1200);
    expect(parseAmount(' 2.50 ', 2)).toBe(250);
    expect(parseAmount('500', 0)).toBe(500);
  });
  it('refuses anything that is not an amount', () => {
    for (const bad of [
      '0',
      '0.00',
      '-1',
      '+1',
      '1,50',
      '1.505',
      '1e3',
      'abc',
      '1.',
      '.5',
      '12345678',
      '1 0',
    ])
      expect(parseAmount(bad, 2), bad).toBeUndefined();
    expect(parseAmount('5.5', 0)).toBeUndefined();
  });
});
