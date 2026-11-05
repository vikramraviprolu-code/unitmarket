// INT-AL AL.7: the case queue and one case, as read models for the operator. Nothing here writes. The v1 shape
// has no buyer id, no publisher id and no message text; `with_message` is for the operator composition read only.
import { IdSchema } from '@umsbx/contracts';
import type { CaseState, SqlExecutor } from '@umsbx/contracts';
import { RESOLVABLE_STATES } from './rules';

export const ALLOWED_CASE_ACTIONS = [
  'diagnose',
  'restore',
  'credit',
  'close_not_charged',
  'offer_refund',
  'close_no_fault',
] as const;
export type CaseAction = (typeof ALLOWED_CASE_ACTIONS)[number];

/** The actions an operator may take now: all six while a case is open or diagnosing, none after. */
export function allowedActions(state: CaseState): CaseAction[] {
  return RESOLVABLE_STATES.includes(state) ? [...ALLOWED_CASE_ACTIONS] : [];
}

export type CaseQueueState = CaseState | 'unresolved';
export interface CaseQueueRow {
  case_id: string;
  kind: string;
  state: string;
  sla_due_at: string;
  order_ref: string | null;
}
export interface CaseQueue {
  items: CaseQueueRow[];
  total: number;
  next_cursor: string | null;
}
export interface CaseDetail extends CaseQueueRow {
  credit_ms: number;
  opened_by: string;
  alerts: { alert_id: string; kind: string }[];
  allowed_actions: CaseAction[];
  buyer_message_present: boolean;
  buyer_message?: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const UNRESOLVED: readonly string[] = ['open', 'diagnosing', 'refund_pending'];

const encode = (sla: string, id: string): string =>
  Buffer.from(`${sla}|${id}`).toString('base64url');
function decode(c: string): { sla: string; id: string } | null {
  try {
    const [sla, id] = Buffer.from(c, 'base64url').toString().split('|');
    if (sla === undefined || id === undefined || Number.isNaN(Date.parse(sla))) return null;
    return { sla: new Date(sla).toISOString(), id };
  } catch {
    return null;
  }
}

interface Raw {
  id: string;
  kind: string;
  state: string;
  sla_due_at: Date | string;
  order_ref: string | null;
}
const row = (r: Raw): CaseQueueRow => ({
  case_id: r.id,
  kind: r.kind,
  state: r.state,
  sla_due_at: new Date(r.sla_due_at).toISOString(),
  order_ref: r.order_ref,
});

/** The queue, soonest SLA first. `state: 'unresolved'` gathers open, diagnosing and refund_pending. */
export async function listCases(
  db: Pick<SqlExecutor, 'query'>,
  q: {
    state?: CaseQueueState | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  },
): Promise<CaseQueue> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const states = q.state === undefined ? null : q.state === 'unresolved' ? UNRESOLVED : [q.state];
  const stateSql = states === null ? 'TRUE' : 'c.state = ANY($1::text[])';
  const base: unknown[] = states === null ? [] : [states];
  const total = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM recovery_cases c WHERE ${stateSql}`,
        base,
      )
    ).rows[0]?.n ?? 0,
  );
  const params = [...base];
  let after = '';
  if (q.cursor !== undefined) {
    const cur = decode(q.cursor);
    if (cur !== null) {
      params.push(cur.sla, cur.id);
      after = `AND (c.sla_due_at, c.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`;
    }
  }
  params.push(limit + 1);
  const r = await db.query<Raw>(
    `SELECT c.id, c.kind, c.state, c.sla_due_at, o.order_ref
       FROM recovery_cases c LEFT JOIN orders o ON o.id = c.order_id
      WHERE ${stateSql} ${after}
      ORDER BY c.sla_due_at, c.id LIMIT $${params.length}`,
    params,
  );
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(row),
    total,
    next_cursor:
      r.rows.length > limit && last !== undefined
        ? encode(new Date(last.sla_due_at).toISOString(), last.id)
        : null,
  };
}

/** One case, or null for an unknown or malformed id. */
export async function getCaseDetail(
  db: Pick<SqlExecutor, 'query'>,
  id: string,
  opts: { with_message?: boolean } = {},
): Promise<CaseDetail | null> {
  if (!IdSchema.safeParse(id).success) return null;
  const r = await db.query<Raw & { credit_ms: number; opened_by: string; buyer_message: string }>(
    `SELECT c.id, c.kind, c.state, c.sla_due_at, o.order_ref, c.credit_ms, c.opened_by, c.buyer_message
       FROM recovery_cases c LEFT JOIN orders o ON o.id = c.order_id WHERE c.id = $1`,
    [id],
  );
  const c = r.rows[0];
  if (c === undefined) return null;
  const alerts = await db.query<{ alert_id: string; kind: string }>(
    `SELECT DISTINCT a.id AS alert_id, a.kind
       FROM recovery_actions ra JOIN alerts a ON a.id = ra.detail ->> 'alert_id'
      WHERE ra.case_id = $1 ORDER BY a.id`,
    [id],
  );
  const out: CaseDetail = {
    ...row(c),
    credit_ms: Number(c.credit_ms),
    opened_by: c.opened_by,
    alerts: alerts.rows,
    allowed_actions: allowedActions(c.state as CaseState),
    buyer_message_present: c.buyer_message.length > 0,
  };
  if (opts.with_message === true) out.buyer_message = c.buyer_message;
  return out;
}
