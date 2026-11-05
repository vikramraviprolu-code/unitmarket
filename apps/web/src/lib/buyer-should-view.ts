// INT-BUY / BUY.6, BUY.7 and BUY.9: the receipts list, the approvals inbox and the notice after a payment return.
// Pure: no server module, no clock (the caller passes `now`), no identity.
import { endsIn } from './buyer-home-view';
import type { PendingApprovalInput } from './buyer-home-view';
import { formatMinor } from './format';

export const RECEIPTS_EMPTY =
  'You have no receipts yet. A receipt appears here once a purchase is paid.';
export const APPROVALS_EMPTY = 'Nothing is waiting for your OK.';
/** Copy only: no timer depends on it. It is the time the page tells the buyer to expect. */
export const PENDING_EXPECTED_MINUTES = 10;

export interface ReceiptInput {
  order_id: string;
  order_ref: string;
  provider_order_ids: string[];
  sellers: string[];
  currency: string;
  total_minor: number;
  created_at: string;
}
export interface ReceiptRow {
  key: string;
  order_ref: string;
  provider_order_id: string;
  seller: string;
  money_text: string;
  date_text: string;
  receipt_href: string;
  order_href: string;
}

export function receiptsModel(items: readonly ReceiptInput[]): {
  rows: ReceiptRow[];
  empty: string | null;
} {
  const rows = items.map((r): ReceiptRow => ({
    key: r.order_id,
    order_ref: r.order_ref,
    provider_order_id:
      r.provider_order_ids.length === 0 ? 'Not issued yet' : r.provider_order_ids.join(', '),
    seller: r.sellers.join(', '),
    money_text: formatMinor(r.total_minor, r.currency),
    date_text: r.created_at.slice(0, 10),
    receipt_href: `/receipts/${encodeURIComponent(r.order_id)}`,
    order_href: `/orders/${encodeURIComponent(r.order_ref)}`,
  }));
  return { rows, empty: rows.length === 0 ? RECEIPTS_EMPTY : null };
}

export function approvalsModel(
  pending: readonly PendingApprovalInput[],
  now: Date,
): { rows: { key: string; href: string; text: string; note: string }[]; empty: string | null } {
  const rows = pending.map((p) => ({
    key: p.approval_id,
    href: `/approve/${encodeURIComponent(p.approval_id)}`,
    text: `${p.titles.join(', ')}, ${formatMinor(p.total_minor, p.currency)}`,
    note: endsIn(p.expires_at, now),
  }));
  return { rows, empty: rows.length === 0 ? APPROVALS_EMPTY : null };
}

const PENDING_STATUSES = new Set([
  'created',
  'awaiting_buyer',
  'capture_requested',
  'capture_claimed',
  'unresolved',
]);

export interface ReturnNotice {
  kind: 'ready' | 'pending' | 'none';
  text: string;
  open_now: { href: string; label: string } | null;
  order_href: string;
}

/** After the buyer returns from payment: Open now when access is ready; the expected time while it is not. */
export function returnNotice(i: {
  status: string;
  entitlement_id: string | null;
  order_ref: string;
}): ReturnNotice {
  const order_href = `/orders/${encodeURIComponent(i.order_ref)}`;
  if (i.entitlement_id !== null)
    return {
      kind: 'ready',
      text: 'Your purchase is ready.',
      open_now: { href: `/library/${encodeURIComponent(i.entitlement_id)}`, label: 'Open now' },
      order_href,
    };
  if (PENDING_STATUSES.has(i.status))
    return {
      kind: 'pending',
      text: `We are confirming your payment. This usually takes less than ${String(PENDING_EXPECTED_MINUTES)} minutes.`,
      open_now: null,
      order_href,
    };
  return { kind: 'none', text: '', open_now: null, order_href };
}
