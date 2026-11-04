import { RATE_SCALE, divRoundHalfAwayFromZero, isIsoDate, parseRate } from './decimal';
import type { FxRates } from './rates';

export type FxCurrency = 'USD' | 'EUR' | 'GBP';

export interface ConvertResult {
  /** The converted amount in minor units of `to`. */
  minor: number;
  /** The ECB date of the rate used; null for the identity, which uses none. */
  rate_date: string | null;
  /** The factor from one unit of `from` to one unit of `to`, for display. The amount is not computed from it. */
  rate: number;
  /** True for a converted figure ("about"); false for the identity. */
  approx: boolean;
}

/** A rate dated at most this many days before `at` is usable (D-085). */
export const FX_MAX_RATE_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

const isCurrency = (c: unknown): c is FxCurrency => c === 'USD' || c === 'EUR' || c === 'GBP';

/**
 * Converts minor units of `from` to minor units of `to` (USD, EUR and GBP all have 2 decimals).
 *
 * The identity (from = to) returns the same amount with rate 1 and approx false, and needs no rate.
 * Otherwise the answer is null when there is no usable rate: none stored, one that is not a positive
 * decimal, or one dated more than 7 days before `at` (compared by UTC calendar day). A cross rate
 * (USD to GBP and back) is derived from the two EUR rates of the one ECB date in `rates`. The arithmetic
 * is exact integer arithmetic; the result is rounded to the nearest minor unit, halves away from zero
 * (2.5 gives 3, -2.5 gives -3). An amount that is not a safe integer, or a result above
 * Number.MAX_SAFE_INTEGER in size, gives null.
 */
export function convert(i: {
  minor: number;
  from: FxCurrency;
  to: FxCurrency;
  rates: FxRates | null;
  at: Date;
}): ConvertResult | null {
  if (!isCurrency(i.from) || !isCurrency(i.to)) return null;
  if (typeof i.minor !== 'number' || !Number.isSafeInteger(i.minor)) return null;
  if (i.from === i.to) return { minor: i.minor, rate_date: null, rate: 1, approx: false };
  const rates = i.rates;
  if (rates === null || typeof rates !== 'object' || !isIsoDate(rates.date)) return null;
  const atMs = i.at instanceof Date ? i.at.getTime() : Number.NaN;
  if (!Number.isFinite(atMs)) return null;
  const ageDays = Math.floor(atMs / DAY_MS) - Date.parse(`${rates.date}T00:00:00Z`) / DAY_MS;
  if (ageDays > FX_MAX_RATE_AGE_DAYS) return null;
  // Units of each currency per one EUR, scaled by RATE_SCALE.
  const per: Record<FxCurrency, bigint | null> = {
    EUR: RATE_SCALE,
    USD: parseRate(rates.eur_usd),
    GBP: parseRate(rates.eur_gbp),
  };
  const rFrom = per[i.from];
  const rTo = per[i.to];
  if (rFrom === null || rTo === null) return null;
  const out = divRoundHalfAwayFromZero(BigInt(i.minor) * rTo, rFrom);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (out > limit || out < -limit) return null;
  return {
    minor: Number(out),
    rate_date: rates.date,
    rate: Number(rTo) / Number(rFrom),
    approx: true,
  };
}
