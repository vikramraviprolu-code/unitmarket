// Order and capture reads. PayPal JSON stops here: payments core sees only contract types.
import {
  CaptureStatusSchema,
  IdSchema,
  ProviderOrderIdSchema,
  ProviderOrderStatusSchema,
} from '@umsbx/contracts';
import type { CaptureRead, CapturedPart, Money, OrderRead, OrderReadUnit } from '@umsbx/contracts';
import { mapError } from './errors';
import { debugIdOf, isRecord } from './headers';
import type { Http, Mapped } from './shapes';
import { fromDecimalString, minorUnitsFor } from './money';

const unreadable = { kind: 'unavailable', retry_after_ms: null } as const;

/** `{ currency_code, value }` to Money, or null when absent or not an exact amount. */
export function moneyOf(v: unknown): Money | null {
  if (!isRecord(v) || typeof v.currency_code !== 'string' || typeof v.value !== 'string')
    return null;
  const r = fromDecimalString(v.value, v.currency_code, minorUnitsFor(v.currency_code));
  return r.ok ? r.value : null;
}

export interface ReadCapture {
  part: CapturedPart;
  amount: Money;
  notes: string[];
}

/** One capture object to a CapturedPart. Null when the capture cannot be read safely. */
export function readCapture(c: unknown): ReadCapture | null {
  if (!isRecord(c) || typeof c.id !== 'string' || c.id.length === 0 || c.id.length > 64)
    return null;
  const status = CaptureStatusSchema.safeParse(c.status);
  if (!status.success) return null;
  const notes: string[] = [];

  // A capture without a readable amount cannot be compared with the unit: malformed.
  const amount = moneyOf(c.amount);
  if (amount === null) return null;

  const breakdown = isRecord(c.seller_receivable_breakdown) ? c.seller_receivable_breakdown : null;
  let paypal_fee_minor: number | null = null;
  if (breakdown !== null && breakdown.paypal_fee !== undefined) {
    const fee = moneyOf(breakdown.paypal_fee);
    if (fee === null) return null;
    if (fee.currency !== amount.currency) notes.push('fee_currency_mismatch');
    else paypal_fee_minor = fee.minor;
  }

  // Refunded total: the receivable breakdown first, then the capture itself, else 0. The source
  // is recorded so a later reader can tell "zero" from "not reported".
  let refunded_minor = 0;
  let source = 'none';
  const fromBreakdown = breakdown?.total_refunded_amount;
  const fromCapture = c.total_refunded_amount;
  if (fromBreakdown !== undefined) {
    const m = moneyOf(fromBreakdown);
    if (m === null) return null;
    refunded_minor = m.minor;
    source = 'seller_receivable_breakdown';
  } else if (fromCapture !== undefined) {
    const m = moneyOf(fromCapture);
    if (m === null) return null;
    refunded_minor = m.minor;
    source = 'capture';
  }
  // PayPal may report 0 here for a refunded capture. The amount is advisory: 05b takes refunded
  // amounts from GET refund. The note lands in the call record outcome.
  notes.push(`refunded_source=${source}`, 'refunded_advisory=use_get_refund');

  const reason =
    isRecord(c.status_details) && typeof c.status_details.reason === 'string'
      ? c.status_details.reason
      : null;
  return {
    part: {
      capture_id: c.id,
      status: status.data,
      status_reason: reason,
      amount,
      paypal_fee_minor,
      refunded_minor,
    },
    amount,
    notes,
  };
}

/** Latest capture of a unit: by create_time, then by id. Undefined when there is none. */
export function latestCapture(unit: Record<string, unknown>): unknown {
  const payments = unit.payments;
  const list =
    isRecord(payments) && Array.isArray(payments.captures) ? (payments.captures as unknown[]) : [];
  let best: unknown;
  let bestKey: [number, string] | null = null;
  for (const c of list) {
    if (!isRecord(c)) continue;
    const t = typeof c.create_time === 'string' ? Date.parse(c.create_time) : Number.NaN;
    const key: [number, string] = [
      Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t,
      typeof c.id === 'string' ? c.id : '',
    ];
    if (bestKey === null || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}

export function purchaseUnits(body: unknown): Record<string, unknown>[] | null {
  if (!isRecord(body)) return null;
  if (body.purchase_units === undefined) return [];
  if (!Array.isArray(body.purchase_units)) return null;
  const out: Record<string, unknown>[] = [];
  for (const u of body.purchase_units as unknown[]) {
    if (!isRecord(u)) return null;
    out.push(u);
  }
  return out;
}

export const referenceOf = (u: Record<string, unknown>): string | null => {
  if (u.reference_id === undefined) return 'default'; // PayPal's own default on a one-unit order
  const r = IdSchema.safeParse(u.reference_id);
  return r.success ? r.data : null;
};

export function mapOrder(h: Http, now: Date): Mapped<OrderRead> {
  if (h.status !== 200) {
    return {
      result:
        h.status >= 200 && h.status <= 299 ? unreadable : mapError(h.status, h.body, h.headers),
    };
  }
  const body = h.body;
  const id = isRecord(body) ? ProviderOrderIdSchema.safeParse(body.id) : null;
  const status = isRecord(body) ? ProviderOrderStatusSchema.safeParse(body.status) : null;
  const rawUnits = purchaseUnits(body);
  if (!id?.success || !status?.success || rawUnits === null) {
    return { result: unreadable, notes: ['malformed_response'] };
  }

  const notes: string[] = [];
  const units: OrderReadUnit[] = [];
  const customIds = new Set<string | null>();
  for (const u of rawUnits) {
    const reference_id = referenceOf(u);
    const amount = moneyOf(u.amount);
    if (reference_id === null || amount === null)
      return { result: unreadable, notes: ['malformed_response'] };
    const payee =
      isRecord(u.payee) && typeof u.payee.merchant_id === 'string' ? u.payee.merchant_id : null;
    customIds.add(typeof u.custom_id === 'string' ? u.custom_id : null);

    const latest = latestCapture(u);
    let capture: CapturedPart | null = null;
    if (latest !== undefined) {
      const c = readCapture(latest);
      if (c === null) return { result: unreadable, notes: ['malformed_response'] };
      capture = c.part;
      notes.push(...c.notes);
    }
    units.push({ reference_id, payee_merchant_id: payee, amount, capture });
  }
  // One custom_id per order in the port: units that disagree read as null, which never matches.
  const only = customIds.size === 1 ? [...customIds][0] : null;
  return {
    result: {
      kind: 'order',
      provider_order_id: id.data,
      status: status.data,
      custom_id: only ?? null,
      read_at: now.toISOString(),
      debug_id: debugIdOf(h.headers, body),
      units,
    },
    notes,
  };
}

export function mapCaptureRead(h: Http, now: Date): Mapped<CaptureRead> {
  if (h.status !== 200) {
    return {
      result:
        h.status >= 200 && h.status <= 299 ? unreadable : mapError(h.status, h.body, h.headers),
    };
  }
  const c = readCapture(h.body);
  if (c === null) return { result: unreadable, notes: ['malformed_response'] };
  return {
    result: {
      kind: 'capture',
      capture: c.part,
      amount: c.amount,
      read_at: now.toISOString(),
      debug_id: debugIdOf(h.headers, h.body),
    },
    notes: c.notes,
  };
}
