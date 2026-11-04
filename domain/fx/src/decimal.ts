// Exact decimal rates. A rate is a decimal string with up to 6 decimals; it is held as a bigint scaled by
// 10^6, so conversion is integer arithmetic and never meets a float. Not exported from index.ts.

export const RATE_SCALE = 1_000_000n;
const RATE_SHAPE = /^(\d{1,5})(?:\.(\d{1,6}))?$/;

/** Scaled integer for a decimal string, or null when it is not a positive rate of the known shape. */
export function parseRate(s: unknown): bigint | null {
  if (typeof s !== 'string') return null;
  const m = RATE_SHAPE.exec(s);
  if (m === null) return null;
  const whole = m[1] ?? '0';
  const frac = (m[2] ?? '').padEnd(6, '0');
  const v = BigInt(whole) * RATE_SCALE + BigInt(frac);
  return v > 0n ? v : null;
}

/** The shortest decimal string for a scaled rate: 1150000n gives "1.15". */
export function formatRate(v: bigint): string {
  const whole = v / RATE_SCALE;
  const frac = (v % RATE_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** n / d rounded to the nearest integer, halves away from zero. d must be above zero. */
export function divRoundHalfAwayFromZero(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/** True when a real calendar date written YYYY-MM-DD (year 1999 or later). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    y >= 1999 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
  );
}
