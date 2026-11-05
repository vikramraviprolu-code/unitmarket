// INT-OPS-A / OPS-A.2 and OPS-A.3: the view logic of the alert list, the alert detail and the shell bell. Pure:
// AL's read shapes in, rows and links in words out. The filters are the ones AL.1 reads (state, severity, kind), the
// totals are AL's own, and the one fix link of an alert is the catalogue's `route#anchor`. Money is written with
// the currency of the order, never a bare number. No identity reaches this file: AL's reads carry none.
import { RESOLVE_REASON_CODES } from '@umsbx/contracts';
import type { AlertDetail, AlertList, NeedsYouRow } from './view-types';
import { formatDateTime, formatMinor } from './format';
import { OPS_NEEDS_CODE } from './ops-copy';

type Row = AlertList['items'][number];

export const ALERT_STATES = ['open', 'acknowledged', 'resolved', 'all'] as const;
export const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'info'] as const;
export type AlertStateFilter = (typeof ALERT_STATES)[number];
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export interface AlertFilter {
  state: AlertStateFilter;
  severity?: AlertSeverity;
  kind?: string;
}

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** Bad input is read as the default, never as an error page. The default is what still waits. */
export function parseAlertFilter(sp: Params): AlertFilter {
  const state = first(sp['state']);
  const severity = first(sp['severity']);
  const kind = first(sp['kind']);
  const f: AlertFilter = {
    state: (ALERT_STATES as readonly string[]).includes(state ?? '')
      ? (state as AlertStateFilter)
      : 'open',
  };
  if ((ALERT_SEVERITIES as readonly string[]).includes(severity ?? ''))
    f.severity = severity as AlertSeverity;
  if (kind !== undefined && /^[a-z][a-z_]{0,39}$/.test(kind)) f.kind = kind;
  return f;
}

export function alertQuery(f: AlertFilter): {
  state: AlertStateFilter;
  severity?: AlertSeverity;
  kind?: string;
} {
  return {
    state: f.state,
    ...(f.severity === undefined ? {} : { severity: f.severity }),
    ...(f.kind === undefined ? {} : { kind: f.kind }),
  };
}

/** `/ops/alerts` for the default, otherwise the filter as a query string, in a fixed order. */
export function alertsHref(f: AlertFilter): string {
  const q = new URLSearchParams();
  if (f.state !== 'open') q.set('state', f.state);
  if (f.severity !== undefined) q.set('severity', f.severity);
  if (f.kind !== undefined) q.set('kind', f.kind);
  const s = q.toString();
  return s === '' ? '/ops/alerts' : `/ops/alerts?${s}`;
}

export const fixHref = (fix: { route: string; anchor: string }): string =>
  `${fix.route}#${fix.anchor}`;

export const orderHref = (ref: string, anchor: string | null): string =>
  `/ops/money/orders/${encodeURIComponent(ref)}${anchor === null ? '' : `#${anchor}`}`;

export function moneyText(
  m: { kind: string; minor: number; currency: string } | null,
): string | null {
  if (m === null) return null;
  const what =
    m.kind === 'order_total'
      ? 'Order total'
      : m.kind === 'unit_amount'
        ? 'Item amount'
        : 'Refund amount';
  return `${what} at risk: ${formatMinor(m.minor, m.currency)}`;
}

/** The anchor of the first order timeline entry whose source is this alert, or null. */
export function orderAnchor(
  entries: readonly { seq: number; source: { table: string; id: string } }[],
  alertId: string,
): string | null {
  const e = entries.find((x) => x.source.table === 'alerts' && x.source.id === alertId);
  return e === undefined ? null : `seq-${String(e.seq)}`;
}

export const RESOLVE_REASON_WORDS: Record<(typeof RESOLVE_REASON_CODES)[number], string> = {
  fixed_upstream: 'fixed upstream',
  false_positive: 'false positive',
  duplicate: 'duplicate',
  accepted_risk: 'accepted risk',
  other: 'other',
};
const reasonWord = (code: string | null): string =>
  code !== null && Object.hasOwn(RESOLVE_REASON_WORDS, code)
    ? RESOLVE_REASON_WORDS[code as keyof typeof RESOLVE_REASON_WORDS]
    : 'no reason given';

export const SEVERITY_WORDS: Record<AlertSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  info: 'Info',
};
export const STATE_WORDS: Record<string, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
};

export interface AlertRowView {
  id: string;
  href: string;
  title: string;
  severity: string;
  severity_word: string;
  state: string;
  state_word: string;
  when: string;
  order_ref: string | null;
  fix_href: string;
}
export interface AlertListView {
  rows: AlertRowView[];
  total: number;
  total_text: string;
  next_href: string | null;
  show_resolved: { on: boolean; href: string };
  filter: AlertFilter;
}

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

export function alertListView(list: AlertList, f: AlertFilter): AlertListView {
  const next = list.next_cursor;
  const base = alertsHref(f);
  const toggle: AlertFilter = { ...f, state: f.state === 'all' ? 'open' : 'all' };
  return {
    rows: list.items.map((a: Row) => ({
      id: a.id,
      href: `/ops/alerts/${a.id}`,
      title: a.title,
      severity: a.severity,
      severity_word: SEVERITY_WORDS[a.severity as AlertSeverity] ?? a.severity,
      state: a.state,
      state_word: STATE_WORDS[a.state] ?? a.state,
      when: formatDateTime(a.created_at),
      order_ref: a.order_ref,
      fix_href: fixHref(a.fix),
    })),
    total: list.total,
    total_text: list.total === 0 ? 'No alerts' : count(list.total, 'alert', 'alerts'),
    next_href:
      next === null
        ? null
        : `${base}${base.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}`,
    show_resolved: { on: f.state === 'all', href: alertsHref(toggle) },
    filter: f,
  };
}

export type AlertActionKind = 'acknowledge' | 'resolve' | 'reopen';
export interface AlertActionView {
  kind: AlertActionKind;
  label: string;
  path: string;
  key: string;
  enabled: boolean;
  hint: string | null;
  reasons?: { code: string; label: string }[];
}
export interface AlertDetailView {
  id: string;
  title: string;
  cause: string;
  next_action: string;
  severity_word: string;
  state: string;
  state_word: string;
  when: string;
  money_text: string | null;
  order_ref: string | null;
  order_href: string | null;
  case_href: string | null;
  fix: { href: string; label: string };
  actions: AlertActionView[];
  history: { text: string; when: string }[];
}

const ACTION_WORDS: Record<AlertActionKind, string> = {
  acknowledge: 'Acknowledge',
  resolve: 'Resolve',
  reopen: 'Reopen',
};
const BY_STATE: Record<string, AlertActionKind[]> = {
  open: ['acknowledge', 'resolve'],
  acknowledged: ['resolve'],
  resolved: ['reopen'],
};

function historyText(h: AlertDetail['history'][number]): string {
  if (h.kind === 'acknowledged') return 'Acknowledged';
  if (h.kind === 'resolved') return `Resolved: ${reasonWord(h.reason_code)}`;
  if (h.kind === 'auto_resolved') return 'Resolved by the system';
  return 'Reopened';
}

/** `keys` are single-use Idempotency-Keys made on the server, one per action (the browser cannot make one). */
export function alertDetailView(
  d: AlertDetail,
  o: {
    mfa: boolean;
    keys: Record<AlertActionKind, string>;
    order_anchor: string | null;
  },
): AlertDetailView {
  const actions = (BY_STATE[d.state] ?? []).map((kind): AlertActionView => {
    const a: AlertActionView = {
      kind,
      label: ACTION_WORDS[kind],
      path: `/api/ops/alerts/${d.id}/${kind}`,
      key: o.keys[kind],
      enabled: o.mfa,
      hint: o.mfa ? null : OPS_NEEDS_CODE,
    };
    if (kind === 'resolve')
      a.reasons = RESOLVE_REASON_CODES.map((code) => ({ code, label: RESOLVE_REASON_WORDS[code] }));
    return a;
  });
  return {
    id: d.id,
    title: d.title,
    cause: d.cause,
    next_action: d.next_action,
    severity_word: SEVERITY_WORDS[d.severity as AlertSeverity] ?? d.severity,
    state: d.state,
    state_word: STATE_WORDS[d.state] ?? d.state,
    when: formatDateTime(d.created_at),
    money_text: moneyText(d.money_at_risk),
    order_ref: d.order_ref,
    order_href: d.order_ref === null ? null : orderHref(d.order_ref, o.order_anchor),
    case_href: d.case_id === null ? null : `/ops/buyers/cases/${d.case_id}`,
    fix: { href: fixHref(d.fix), label: 'Open the fix' },
    actions,
    history: [...d.history]
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((h) => ({ text: historyText(h), when: formatDateTime(h.at) })),
  };
}

export interface BellCounts {
  critical: number;
  high: number;
  medium: number;
  info: number;
  total: number;
}

/** The open alerts by severity, read from the sentences of AL's needs-you rows (open_alerts rows only). */
export function bellCounts(rows: readonly NeedsYouRow[]): BellCounts {
  const out: BellCounts = { critical: 0, high: 0, medium: 0, info: 0, total: 0 };
  for (const r of rows) {
    if (r.kind !== 'open_alerts') continue;
    const m = /^\d+ (critical|high|medium|info) alerts? (?:is|are) waiting/.exec(r.sentence);
    if (m === null) continue;
    out[m[1] as AlertSeverity] += r.count;
    out.total += r.count;
  }
  return out;
}

/** The words of the bell for a screen reader and the tooltip. */
export function bellLabel(c: BellCounts): string {
  if (c.total === 0) return 'Alerts: none waiting';
  const parts = ALERT_SEVERITIES.filter((s) => c[s] > 0).map((s) => `${String(c[s])} ${s}`);
  return `Alerts: ${parts.join(', ')}`;
}
