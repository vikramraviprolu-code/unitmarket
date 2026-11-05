// INT-OPS-A / OPS-A.4: the view of the operator order page /ops/money/orders/[ref]. A summary, the units with one
// evidence button each, the TR1 operator timeline and the one fix link of an alert on the order. Pure: the facts in,
// words and links out. Identity (the buyer's name, whole PayPal ids, the request id, the address prefix and the
// browser) is put in only when the session has the second factor (C3); without it a PayPal id is "…" and its last
// four. Every timeline row has the id seq-<n> from its TR1 seq, so a link from an alert can open the page at it.
import type { TimelineEntryView, TimelineView } from './timeline-view';
import { timelineView } from './timeline-view';
import { formatDateTime, formatMinor } from './format';
import { OPS_NEEDS_CODE } from './ops-copy';
import { fixHref } from './ops-alerts-view';

/** TR1's operator entry, with its optional fields allowed to be undefined as the journal read gives them. */
export type OrderEntry = Omit<TimelineEntryView, 'amount_minor' | 'state_from' | 'state_to'> & {
  amount_minor?: number | undefined;
  state_from?: string | undefined;
  state_to?: string | undefined;
  req_id?: string | null | undefined;
  ip_hash?: string | null | undefined;
  ua_family?: string | null | undefined;
};

function plain(e: OrderEntry): TimelineEntryView {
  const out: TimelineEntryView = {
    at: e.at,
    seq: e.seq,
    event_type: e.event_type,
    words_key: e.words_key,
    actor: e.actor,
    channel: e.channel,
    source: e.source,
    verified: e.verified,
  };
  if (e.amount_minor !== undefined) out.amount_minor = e.amount_minor;
  if (e.state_from !== undefined) out.state_from = e.state_from;
  if (e.state_to !== undefined) out.state_to = e.state_to;
  return out;
}

export interface OrderPageInput {
  order: {
    order_ref: string;
    status: string;
    total_minor: number;
    currency: string;
    environment: string;
    created_at: string;
    buyer_name: string | null;
  };
  units: { id: string; amount_minor: number; status: string; capture_id: string | null }[];
  provider_orders?: { provider_order_id: string }[];
  entries: readonly OrderEntry[];
  truncated: boolean;
  words: Readonly<Record<string, string>>;
  alerts: { id: string; fix: { route: string; anchor: string } }[];
  mfa: boolean;
}

export interface EvidenceButton {
  label: string;
  href: string | null;
  enabled: boolean;
}
export interface OrderPageView {
  order_ref: string;
  environment: string;
  status: string;
  total_text: string;
  created_text: string;
  /** The buyer's name, only with the second factor. */
  buyer: string | null;
  units: { id: string; amount_text: string; status: string; evidence: EvidenceButton }[];
  /** PayPal order and capture ids: whole with the second factor, otherwise "…" and the last four. */
  provider_ids: { label: string; value: string }[];
  /** Request id, address prefix and browser of the steps that have them. Empty without the second factor. */
  request_details: { seq: number; req_id: string | null; address: string | null; browser: string | null }[];
  timeline: TimelineView;
  /** seq-<n> of each timeline entry, in entry order. */
  anchors: string[];
  fix: { href: string; label: string } | null;
  alerts: { id: string; href: string }[];
}

const words = (s: string): string => s.replace(/_/g, ' ');
const mask = (id: string): string => (id.length <= 4 ? '…' : `…${id.slice(-4)}`);

export const evidenceFor = (unitId: string, mfa: boolean): EvidenceButton =>
  mfa
    ? { label: 'Evidence pack', href: `/api/ops/units/${unitId}/evidence.html`, enabled: true }
    : { label: OPS_NEEDS_CODE, href: null, enabled: false };

export function orderPageView(i: OrderPageInput): OrderPageView {
  const shown = (id: string): string => (i.mfa ? id : mask(id));
  const ids: { label: string; value: string }[] = [];
  for (const [n, p] of (i.provider_orders ?? []).entries())
    ids.push({ label: `PayPal order ${String(n + 1)}`, value: shown(p.provider_order_id) });
  for (const u of i.units)
    if (u.capture_id !== null) ids.push({ label: `Capture of ${u.id}`, value: shown(u.capture_id) });
  const details = i.mfa
    ? i.entries
        .filter((e) => e.req_id != null || e.ip_hash != null || e.ua_family != null)
        .map((e) => ({
          seq: e.seq,
          req_id: e.req_id ?? null,
          address: e.ip_hash ?? null,
          browser: e.ua_family ?? null,
        }))
    : [];
  const first = i.alerts[0];
  return {
    order_ref: i.order.order_ref,
    environment: i.order.environment,
    status: words(i.order.status),
    total_text: formatMinor(i.order.total_minor, i.order.currency),
    created_text: formatDateTime(i.order.created_at),
    buyer: i.mfa ? i.order.buyer_name : null,
    units: i.units.map((u) => ({
      id: u.id,
      amount_text: formatMinor(u.amount_minor, i.order.currency),
      status: words(u.status),
      evidence: evidenceFor(u.id, i.mfa),
    })),
    provider_ids: ids,
    request_details: details,
    timeline: timelineView(
      { entries: i.entries.map(plain), truncated: i.truncated },
      { words: i.words, currency: i.order.currency },
    ),
    anchors: i.entries.map((e) => `seq-${String(e.seq)}`),
    fix: first === undefined ? null : { href: fixHref(first.fix), label: 'Open the fix' },
    alerts: i.alerts.map((a) => ({ id: a.id, href: `/ops/alerts/${a.id}` })),
  };
}
