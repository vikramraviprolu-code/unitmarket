// Adapted from AIC_Hackathon_UnitMarket packages/core/approval/canonical.ts (formatCents) at
// a36ddc03fd0b962000f686291c145b50ee337f90. Generalised from cents to minor units. Owned by SBX.
// Money never passes through floating point: text to BigInt to a safe integer, and back by
// integer division. Nothing here uses Number() on a decimal string.
import { err, ok } from '@umsbx/contracts';
import type { Money, Result } from '@umsbx/contracts';

export type MinorUnitsExp = 0 | 2 | 3;

// PayPal currencies without a decimal part (HUF, JPY, TWD). None of PayPal's currencies uses
// three decimals, but the contract allows them, so the code handles them.
const ZERO_DECIMAL: ReadonlySet<string> = new Set(['HUF', 'JPY', 'TWD']);

/** Decimal places PayPal uses for a currency. Unknown currencies get 2. */
export function minorUnitsFor(currency: string): MinorUnitsExp {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

const CURRENCY = /^[A-Z]{3}$/;
// digits, then optionally a dot and digits: no sign, exponent, spaces, separators or lone dot
const PLAIN_DECIMAL = /^([0-9]{1,20})(?:\.([0-9]{1,20}))?$/;

/** 250 with minor_units 2 gives "2.50". Throws for a minor value that is not a safe integer >= 0. */
export function toDecimalString(m: Money, minor_units: MinorUnitsExp): string {
  const n = m.minor;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('minor units must be a non-negative safe integer');
  }
  if (minor_units === 0) return String(n);
  const scale = 10 ** minor_units; // 100 or 1000: exact
  const whole = Math.floor(n / scale);
  const frac = n % scale;
  return `${whole}.${String(frac).padStart(minor_units, '0')}`;
}

/**
 * Exact parse. Refuses more decimals than minor_units (even zeros), signs, exponents, spaces,
 * and anything that is not a safe integer once scaled.
 */
export function fromDecimalString(
  v: string,
  currency: string,
  minor_units: MinorUnitsExp,
): Result<Money, 'bad_amount'> {
  if (typeof v !== 'string' || !CURRENCY.test(currency)) return err('bad_amount');
  const m = PLAIN_DECIMAL.exec(v);
  if (m === null) return err('bad_amount');
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (frac.length > minor_units) return err('bad_amount');
  const scaled =
    BigInt(whole) * 10n ** BigInt(minor_units) + BigInt(frac.padEnd(minor_units, '0') || '0');
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return err('bad_amount');
  return ok({ currency, minor: Number(scaled) });
}
