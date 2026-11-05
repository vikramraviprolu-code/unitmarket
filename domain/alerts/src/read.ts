// INT-AL / AL.1: the operator list of alerts and one alert with its history. Every row says what the catalogue
// says about its kind, plus the order ref, the unit, the money at risk and the linked case. No buyer, no seller
// and no PayPal id is selected: the answer is order refs, unit ids, amounts, states and ids.
import { LAST_EVENT, stateOfKind } from './state';
import type { AlertState } from './state';
import { ALERT_KINDS, describeAlert, kindsOf } from './catalogue';
import type { Fix, MoneyRule, Severity } from './catalogue';
import type { SqlExecutor } from '@umsbx/contracts';

type Q = Pick<SqlExecutor, 'query'>;

export interface MoneyAtRisk {
  kind: MoneyRule;
  minor: number;
  currency: string;
}
export interface AlertRow {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  cause: string;
  state: AlertState;
  order_ref: string | null;
  unit_id: string | null;
  money_at_risk: MoneyAtRisk | null;
  case_id: string | null;
  fix: Fix;
  next_action: string;
  created_at: string;
}
export interface AlertHistoryEntry {
  kind: 'acknowledged' | 'resolved' | 'auto_resolved' | 'reopened';
  reason_code: string | null;
  at: string;
  actor_kind: string | null;
  actor_id: string | null;
  channel: string | null;
}
export interface AlertDetail extends AlertRow {
  history: AlertHistoryEntry[];
}
export interface AlertList {
  items: AlertRow[];
  total: number;
  next_cursor: string | null;
}
export interface AlertQuery {
  state?: 'open' | 'acknowledged' | 'resolved' | 'all' | undefined;
  severity?: Severity | undefined;
  kind?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const FALLBACK_FIX: Fix = { route: '/ops', anchor: 'ops-alerts' };

interface Raw {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  created_text: string;
  last: string | null;
  order_ref: string | null;
  unit_id: string | null;
  order_total: string | number | null;
  unit_amount: string | number | null;
  currency: string | null;
  refund_amount: string | number | null;
  detail_amount: string | number | null;
  case_id: string | null;
}

const COLUMNS = `
  a.id, a.kind, a.detail, a.unit_id,
  to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_text,
  ${LAST_EVENT} AS last,
  o.order_ref, o.total_minor AS order_total, o.currency, u.amount_minor AS unit_amount,
  rr.amount_minor AS refund_amount, (a.detail ->> 'amount_minor') AS detail_amount,
  (SELECT ra.case_id FROM recovery_actions ra WHERE ra.detail ->> 'alert_id' = a.id
    ORDER BY ra.at DESC, ra.id DESC LIMIT 1) AS case_id`;
const FROM = `
  FROM alerts a
  LEFT JOIN order_units u ON u.id = a.unit_id
  LEFT JOIN orders o ON o.id = COALESCE(a.order_id, u.order_id)
  LEFT JOIN refund_requests rr ON rr.id = (a.detail ->> 'refund_request_id')`;

function toRow(r: Raw): AlertRow {
  const reason = typeof r.detail['reason'] === 'string' ? r.detail['reason'] : '';
  const d = describeAlert(r.kind, reason, r.detail);
  const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
  let money: MoneyAtRisk | null = null;
  if (d?.money_at_risk != null && r.currency !== null) {
    const rule = d.money_at_risk;
    const minor =
      rule === 'order_total'
        ? num(r.order_total)
        : rule === 'unit_amount'
          ? num(r.unit_amount)
          : (num(r.refund_amount) ?? num(r.detail_amount) ?? num(r.unit_amount));
    if (minor !== null) money = { kind: rule, minor, currency: r.currency };
  }
  return {
    id: r.id,
    kind: r.kind,
    severity: d?.severity ?? 'info',
    title: d?.title ?? r.kind.replace(/_/g, ' '),
    cause: d?.cause ?? 'This alert kind has no description yet; read its order.',
    state: stateOfKind(r.last),
    order_ref: r.order_ref,
    unit_id: r.unit_id,
    money_at_risk: money,
    case_id: r.case_id,
    fix: d?.fix ?? FALLBACK_FIX,
    next_action: d?.runbook ?? 'Open the order and decide by hand.',
    created_at: new Date(r.created_text).toISOString(),
  };
}

const encode = (c: { t: string; i: string }): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(s: string): { t: string; i: string } | null {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    return typeof c.t === 'string' && typeof c.i === 'string' && !Number.isNaN(Date.parse(c.t))
      ? { t: c.t, i: c.i }
      : null;
  } catch {
    return null;
  }
}

function filters(q: AlertQuery): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const state = q.state ?? 'open';
  if (state === 'open') where.push(`COALESCE(${LAST_EVENT}, 'open') IN ('open', 'reopened')`);
  else if (state === 'acknowledged') where.push(`${LAST_EVENT} = 'acknowledged'`);
  else if (state === 'resolved') where.push(`${LAST_EVENT} IN ('resolved', 'auto_resolved')`);
  if (q.kind !== undefined) where.push(`a.kind = ${add(q.kind)}`);
  if (q.severity !== undefined) {
    const kinds = kindsOf(q.severity);
    // A kind the catalogue does not know is shown as info, so it is found by that filter too.
    where.push(
      q.severity === 'info'
        ? `(a.kind = ANY(${add(kinds)}::text[]) OR NOT (a.kind = ANY(${add([...ALERT_KINDS])}::text[])))`
        : `a.kind = ANY(${add(kinds)}::text[])`,
    );
  }
  return { where, params };
}

/** Open means open or reopened here; the default list is what still waits (open and acknowledged are asked for apart). */
export async function listAlerts(db: Q, q: AlertQuery): Promise<AlertList> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const f = filters(q);
  const total = await db.query<{ c: string | number }>(
    `SELECT count(*) AS c FROM alerts a${f.where.length ? ` WHERE ${f.where.join(' AND ')}` : ''}`,
    f.params,
  );
  const where = [...f.where];
  const params = [...f.params];
  if (q.cursor !== undefined) {
    const c = decode(q.cursor);
    if (c !== null) {
      params.push(c.t, c.i);
      where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
  }
  params.push(limit + 1);
  const rows = await db.query<Raw>(
    `SELECT ${COLUMNS} ${FROM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toRow),
    total: Number(total.rows[0]?.c ?? 0),
    next_cursor:
      rows.rows.length > limit && last !== undefined
        ? encode({ t: last.created_text, i: last.id })
        : null,
  };
}

export async function getAlert(db: Q, id: string): Promise<AlertDetail | null> {
  const r = await db.query<Raw>(`SELECT ${COLUMNS} ${FROM} WHERE a.id = $1`, [id]);
  const row = r.rows[0];
  if (row === undefined) return null;
  const h = await db.query<{
    kind: AlertHistoryEntry['kind'];
    reason_code: string | null;
    at: string | Date;
    actor_kind: string | null;
    actor_id: string | null;
    channel: string | null;
  }>(
    `SELECT e.kind, e.reason_code, e.at, t.actor_kind, t.actor_id, t.channel
       FROM alert_events e
       LEFT JOIN trace_events t ON t.source_table = 'alert_events' AND t.source_id = e.id
      WHERE e.alert_id = $1 ORDER BY e.seq`,
    [id],
  );
  return {
    ...toRow(row),
    history: h.rows.map((x) => ({ ...x, at: new Date(x.at).toISOString() })),
  };
}
