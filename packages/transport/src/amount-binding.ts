// Amount binding (FIX-BPREP M4). The caller's `amount_minor` is the figure the outbound gate caps;
// for the two operations that move money it must equal what the body actually asks PayPal for.
// Pure text-to-integer parsing: no floating point.
import type { PayPalOperation } from '@umsbx/contracts';

const ZERO_DECIMAL: ReadonlySet<string> = new Set(['HUF', 'JPY', 'TWD']);
const CURRENCY = /^[A-Z]{3}$/;
const PLAIN = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,6}))?$/;

/** Operations whose body carries an amount the transport must bind to `amount_minor`. */
export const AMOUNT_BOUND: ReadonlySet<PayPalOperation> = new Set([
  'create_order',
  'refund_capture',
]);

function minorOf(a: unknown): { currency: string; minor: number } | null {
  if (typeof a !== 'object' || a === null) return null;
  const { currency_code: c, value: v } = a as { currency_code?: unknown; value?: unknown };
  if (typeof c !== 'string' || !CURRENCY.test(c) || typeof v !== 'string') return null;
  const m = PLAIN.exec(v);
  if (m === null) return null;
  const exp = ZERO_DECIMAL.has(c) ? 0 : 2;
  const frac = m[2] ?? '';
  if (frac.length > exp) return null;
  const scaled = BigInt(m[1] as string) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0') || '0');
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { currency: c, minor: Number(scaled) };
}

/**
 * The amount (minor units) a money-moving body asks for, or null when the body is unparsable, has
 * no amount (a full refund by omission), or mixes currencies. create_order sums its purchase units.
 */
export function bodyAmountMinor(op: PayPalOperation, body: string | null): number | null {
  if (body === null) return null;
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null) return null;
  if (op === 'refund_capture') return minorOf((j as { amount?: unknown }).amount)?.minor ?? null;
  if (op === 'create_order') {
    const units = (j as { purchase_units?: unknown }).purchase_units;
    if (!Array.isArray(units) || units.length === 0) return null;
    let total = 0;
    let currency: string | null = null;
    for (const u of units) {
      const m = minorOf((u as { amount?: unknown } | null)?.amount);
      if (m === null) return null;
      if (currency !== null && currency !== m.currency) return null;
      currency = m.currency;
      total += m.minor;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  }
  return null;
}
