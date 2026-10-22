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

/**
 * True when any JSON object in `text` repeats a key (compared after unescaping). Expects text that
 * JSON.parse already accepted. JSON.parse keeps the last duplicate, another parser may keep the
 * first, so a body with a repeated key is ambiguous and is never sent (FIX-MVPB-SEAL2 M2).
 */
export function hasDuplicateKey(text: string): boolean {
  const stack: (Set<string> | null)[] = []; // a Set per open object, null per open array
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '{') {
      stack.push(new Set());
      i += 1;
    } else if (c === '[') {
      stack.push(null);
      i += 1;
    } else if (c === '}' || c === ']') {
      stack.pop();
      i += 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < n && /\s/.test(text[k] as string)) k += 1;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
      }
      i = j + 1;
    } else i += 1;
  }
  return false;
}

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

export interface CheckedMoneyBody {
  /** The amount in minor units that the body asks PayPal for. */
  minor: number;
  /** The single ISO currency of that amount. */
  currency: string;
  /** The exact text to put on the wire: the re-serialisation of the value that was checked. */
  body: string;
  /** True when a purchase unit names a `payee` (a different merchant account to be paid). */
  payee: boolean;
}

/**
 * Checks a money-moving body and returns what to send. Null when the body is unparsable, is not a
 * JSON object, repeats a key anywhere, has no amount (a full refund by omission), or mixes
 * currencies. create_order sums its purchase units. The returned `body` is JSON.stringify of the
 * parsed value, so the bytes that go out are the bytes that were checked (FIX-MVPB-SEAL2 M2).
 */
export function canonicalMoneyBody(
  op: PayPalOperation,
  body: string | null,
): CheckedMoneyBody | null {
  if (body === null) return null;
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  if (hasDuplicateKey(body)) return null;
  const out = JSON.stringify(j);
  if (op === 'refund_capture') {
    const m = minorOf((j as { amount?: unknown }).amount);
    return m === null ? null : { minor: m.minor, currency: m.currency, body: out, payee: false };
  }
  if (op === 'create_order') {
    const units = (j as { purchase_units?: unknown }).purchase_units;
    if (!Array.isArray(units) || units.length === 0) return null;
    let total = 0;
    let currency: string | null = null;
    let payee = false;
    for (const u of units) {
      const m = minorOf((u as { amount?: unknown } | null)?.amount);
      if (m === null) return null;
      if (currency !== null && currency !== m.currency) return null;
      currency = m.currency;
      total += m.minor;
      if (!Number.isSafeInteger(total)) return null;
      if (typeof u === 'object' && u !== null && Object.hasOwn(u, 'payee')) payee = true;
    }
    return currency === null ? null : { minor: total, currency, body: out, payee };
  }
  return null;
}

/** The amount (minor units) a money-moving body asks for, or null; see canonicalMoneyBody. */
export function bodyAmountMinor(op: PayPalOperation, body: string | null): number | null {
  return canonicalMoneyBody(op, body)?.minor ?? null;
}
