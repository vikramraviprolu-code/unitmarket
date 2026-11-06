// POB-M1 (D-089): the one fee function. The fee is a share of the publisher's price, in basis points, rounded
// half away from zero; the buyer pays price plus fee. Pure: no database, no clock.
import { describe, expect, it } from 'vitest';
import { FEE_BPS_MAX, applyFee, fixedFeePolicy } from './index';

// [seller price in minor units, fee in basis points, fee in minor units]
const TABLE: [number, number, number][] = [
  [100, 1000, 10],
  [1, 1000, 0], // 0.1 rounds down
  [4, 1000, 0], // 0.4 rounds down
  [5, 1000, 1], // 0.5 rounds away from zero
  [6, 1000, 1], // 0.6
  [14, 1000, 1], // 1.4
  [15, 1000, 2], // 1.5 rounds up
  [25, 1000, 3], // 2.5 rounds up (never to even)
  [35, 1000, 4], // 3.5
  [1999, 1000, 200], // 199.9
  [364, 1000, 36], // 36.4
  [1, 3000, 0], // 0.3
  [2, 3000, 1], // 0.6
  [5, 3000, 2], // 1.5 rounds up
  [5000, 1, 1], // 0.5 at 1 bp rounds up
  [4999, 1, 0], // 0.4999
  [2000, 3000, 600],
  [2_000_000_000, 1000, 200_000_000],
];

describe('applyFee', () => {
  it.each(TABLE)('price %i at %i bp gives a fee of %i', (seller, bps, fee) => {
    expect(applyFee(seller, bps)).toEqual({
      seller_minor: seller,
      fee_minor: fee,
      buyer_minor: seller + fee,
    });
  });
  it('a zero fee leaves the buyer price equal to the seller price', () => {
    for (const seller of [1, 2, 99, 400, 2000]) {
      expect(applyFee(seller, 0)).toEqual({
        seller_minor: seller,
        fee_minor: 0,
        buyer_minor: seller,
      });
    }
  });
  it('the ceiling is 30 percent: 3000 basis points pass, 3001 do not', () => {
    expect(FEE_BPS_MAX).toBe(3000);
    expect(applyFee(100, 3000).fee_minor).toBe(30);
    expect(() => applyFee(100, 3001)).toThrow(RangeError);
    expect(() => applyFee(100, 10_000)).toThrow(RangeError);
  });
  it('refuses a basis point value that is not a whole number from 0 to 3000', () => {
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1000' as unknown as number,
    ]) {
      expect(() => applyFee(100, bad)).toThrow(RangeError);
    }
  });
  it('refuses a price that is not a safe whole number of minor units', () => {
    for (const bad of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '100' as unknown as number,
    ]) {
      expect(() => applyFee(bad, 1000)).toThrow(RangeError);
    }
  });
  it('refuses a result that would leave the safe integers', () => {
    expect(() => applyFee(Number.MAX_SAFE_INTEGER, 3000)).toThrow(RangeError);
    expect(applyFee(Number.MAX_SAFE_INTEGER - 3_000_000_000_000_000, 0).fee_minor).toBe(0);
  });
  it('is exact for large prices (no floating point drift)', () => {
    // 7_000_000_000_001 * 1000 / 10000 = 700_000_000_000.1
    expect(applyFee(7_000_000_000_001, 1000).fee_minor).toBe(700_000_000_000);
    // 9_007_199_254_740 * 3000 / 10000 = 2_702_159_776_422.0 exactly
    expect(applyFee(9_007_199_254_740, 3000).fee_minor).toBe(2_702_159_776_422);
  });
  it('the buyer price is always the seller price plus the fee, and the fee is never above 30 percent', () => {
    for (let seller = 1; seller <= 600; seller += 1) {
      for (const bps of [0, 1, 250, 999, 1000, 1001, 2999, 3000]) {
        const r = applyFee(seller, bps);
        expect(r.buyer_minor).toBe(r.seller_minor + r.fee_minor);
        expect(r.fee_minor).toBeGreaterThanOrEqual(0);
        expect(r.fee_minor).toBeLessThanOrEqual(Math.ceil((seller * bps) / 10_000));
        expect(Math.abs(r.fee_minor - (seller * bps) / 10_000)).toBeLessThanOrEqual(0.5);
      }
    }
  });
});

describe('FeePolicy', () => {
  it('fixedFeePolicy returns the parts with the rate they were made at, and no tax', () => {
    const policy = fixedFeePolicy(1000);
    expect(policy.fee_bps).toBe(1000);
    expect(policy.feeFor(364, 'USD')).toEqual({
      seller_minor: 364,
      fee_minor: 36,
      buyer_minor: 400,
      fee_bps: 1000,
      tax_minor: 0,
    });
  });
  it('a zero rate gives buyer equals seller', () => {
    expect(fixedFeePolicy(0).feeFor(250, 'EUR')).toEqual({
      seller_minor: 250,
      fee_minor: 0,
      buyer_minor: 250,
      fee_bps: 0,
      tax_minor: 0,
    });
  });
  it('refuses a rate outside 0 to 3000 when it is built', () => {
    expect(() => fixedFeePolicy(3001)).toThrow(RangeError);
    expect(() => fixedFeePolicy(-1)).toThrow(RangeError);
  });
  it('refuses a currency that is not three capital letters', () => {
    expect(() => fixedFeePolicy(1000).feeFor(100, 'usd')).toThrow(RangeError);
  });
});
