// INT-TR1 / TR1.1: reading the journal into entries. This file loads the raw rows of one order (or one unit)
// and turns each into a rich entry: time, actor, channel, state change, amount, words key and the copied
// columns. It decides nothing about who may see what: views.ts is the only place that does, and the only
// caller of the loaders for a persona. The 500 entry cap is applied here, on the oldest first.
import type { SqlExecutor } from '@umsbx/contracts';
import type { ActorKind, TraceChannel } from './kinds';
import { wordsKeyOf } from './words';

export const TIMELINE_CAP = 500;

/** One journal row with the context it was written under (ctx fields are null when the context was pruned). */
export interface RawEvent {
  chain_key: string;
  seq: number;
  occurred_at: string;
  actor_kind: ActorKind;
  actor_id: string | null;
  on_behalf_of: string | null;
  mandate_id: string | null;
  mfa: boolean;
  ctx_id: string | null;
  channel: TraceChannel | null;
  event_type: string;
  source_table: string;
  source_id: string;
  order_id: string | null;
  unit_id: string | null;
  buyer_id: string | null;
  publisher_id: string | null;
  body: { op?: string; n?: number; cols?: Record<string, [unknown, unknown]> };
  /** The row hash recomputed in SQL equals the stored one. */
  verified: boolean;
  req_id: string | null;
  ip_hash: string | null;
  ua_family: string | null;
  api_key_id: string | null;
  job: string | null;
  tool: string | null;
}

export interface Loaded {
  events: RawEvent[];
  truncated: boolean;
}

export const EVENT_COLUMNS = `e.chain_key, e.seq::int AS seq,
  to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
  e.actor_kind, e.actor_id, e.on_behalf_of, e.mandate_id, e.mfa, e.ctx_id, e.channel, e.event_type,
  e.source_table, e.source_id, e.order_id, e.unit_id, e.buyer_id, e.publisher_id, e.body,
  (trace_sha(trace_canon(e)) = e.row_hash) AS verified,
  c.req_id, c.ip_hash, c.ua_family, c.api_key_id, c.job, c.tool`;
export const EVENT_FROM = 'FROM trace_events e LEFT JOIN trace_context c ON c.id = e.ctx_id';
const SELECT = `SELECT ${EVENT_COLUMNS} ${EVENT_FROM}`;
const ORDER = 'ORDER BY e.occurred_at, e.chain_key, e.seq';

async function run(
  db: SqlExecutor,
  where: string,
  params: unknown[],
  tables: readonly string[] | undefined,
): Promise<Loaded> {
  const p = [...params];
  let w = where;
  if (tables !== undefined) {
    p.push([...tables]);
    w += ` AND e.source_table = ANY($${p.length}::text[])`;
  }
  const r = await db.query<RawEvent>(`${SELECT} WHERE ${w} ${ORDER} LIMIT ${TIMELINE_CAP + 1}`, p);
  return { events: r.rows.slice(0, TIMELINE_CAP), truncated: r.rows.length > TIMELINE_CAP };
}

/** Every journal row of one order. `tables` limits it to the source tables a persona may see. */
export function loadOrderEvents(
  db: SqlExecutor,
  order_id: string,
  tables?: readonly string[],
): Promise<Loaded> {
  return run(db, 'e.order_id = $1', [order_id], tables);
}

/**
 * The rows of one unit of an order: the rows that name the unit, the order's own rows (views.ts rewrites
 * them), and the access rows of the unit's entitlements. Nothing that names another unit.
 */
export function loadUnitEvents(
  db: SqlExecutor,
  order_id: string,
  unit_id: string,
  tables?: readonly string[],
): Promise<Loaded> {
  return run(
    db,
    `e.order_id = $1 AND (e.unit_id = $2 OR e.source_table = 'orders'
       OR (e.source_table = 'access_events' AND e.source_id IN
            (SELECT a.id FROM access_events a JOIN entitlements n ON n.id = a.entitlement_id WHERE n.unit_id = $2))
       OR (e.source_table = 'links' AND e.source_id IN
            (SELECT l.id FROM links l JOIN entitlements n ON n.id = l.entitlement_id WHERE n.unit_id = $2))
       OR (e.source_table = 'access_windows' AND e.source_id IN
            (SELECT n.id FROM entitlements n WHERE n.unit_id = $2)))`,
    [order_id, unit_id],
    tables,
  );
}

export async function findOrder(
  db: SqlExecutor,
  order_ref: string,
): Promise<{ id: string; buyer_id: string } | null> {
  const r = await db.query<{ id: string; buyer_id: string }>(
    'SELECT id, buyer_id FROM orders WHERE order_ref = $1',
    [order_ref],
  );
  return r.rows[0] ?? null;
}

export async function findUnit(
  db: SqlExecutor,
  unit_id: string,
): Promise<{ id: string; order_id: string; publisher_id: string } | null> {
  const r = await db.query<{ id: string; order_id: string; publisher_id: string }>(
    'SELECT id, order_id, publisher_id FROM order_units WHERE id = $1',
    [unit_id],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------

/** Which copied column says "the state" of each table, in the order they are looked at. */
const STATE_COLUMNS: Record<string, readonly string[]> = {
  orders: ['status'],
  order_units: ['status'],
  provider_orders: ['state', 'status'],
  operations: ['state'],
  refund_requests: ['state'],
  entitlements: ['access_state', 'money_state', 'licence_state'],
  access_windows: ['state'],
  recovery_cases: ['state'],
  mandate_reservations: ['state'],
  publishers: ['status'],
  offers: ['status'],
};

/** The copied column that holds the amount of each table. */
const AMOUNT_COLUMN: Record<string, string> = {
  orders: 'total_minor',
  order_units: 'amount_minor',
  ledger_entries: 'amount_minor',
  refund_requests: 'amount_minor',
  mandate_reservations: 'amount_minor',
};

const present = (v: unknown): v is string | number | boolean => v !== null && v !== undefined;

export interface RichEntry {
  at: string;
  seq: number;
  event_type: string;
  words_key: string;
  actor: { kind: ActorKind; label: string };
  channel: TraceChannel;
  amount_minor?: number;
  state_from?: string;
  state_to?: string;
  source: { table: string; id: string };
  verified: boolean;
  chain_key: string;
  actor_id: string | null;
  req_id: string | null;
  ip_hash: string | null;
  ua_family: string | null;
  api_key_id: string | null;
  mfa: boolean;
  job: string | null;
  tool: string | null;
  /** The copied columns this event wrote (new values). Provider ids are masked by operatorView. */
  details: Record<string, unknown>;
  /** Raw facts views.ts needs and then drops. */
  raw: { on_behalf_of: string | null; unit_id: string | null; buyer_id: string | null };
}

export const KIND_WORDS: Record<ActorKind, string> = {
  buyer: 'Buyer',
  publisher: 'Seller',
  operator: 'Operator',
  agent: 'Agent',
  api_client: 'API client',
  system: 'UnitMarket',
  paypal: 'PayPal',
  unattributed: 'Unknown',
};

// A row with no context has no channel. The nearest honest word is a direct database write, which is how a
// script or the command line reaches it.
const NO_CHANNEL: TraceChannel = 'cli';

/** Turns raw rows into rich entries, in the order they were given. Amounts are carried forward per source row. */
export function toRichEntries(events: readonly RawEvent[]): RichEntry[] {
  const bySource = new Map<string, RawEvent[]>();
  for (const e of events) {
    const k = `${e.source_table}|${e.source_id}`;
    bySource.set(k, [...(bySource.get(k) ?? []), e]);
  }
  const amount = new Map<RawEvent, number>();
  for (const list of bySource.values()) {
    let cur: number | undefined;
    for (const e of [...list].sort((a, b) => (a.body.n ?? 0) - (b.body.n ?? 0))) {
      const col = AMOUNT_COLUMN[e.source_table];
      const v = col === undefined ? undefined : e.body.cols?.[col]?.[1];
      if (typeof v === 'number') cur = v;
      else if (typeof v === 'string' && /^\d+$/.test(v)) cur = Number(v);
      if (cur !== undefined) amount.set(e, cur);
    }
  }
  return events.map((e): RichEntry => {
    const cols = e.body.cols ?? {};
    let state_from: string | undefined;
    let state_to: string | undefined;
    for (const c of STATE_COLUMNS[e.source_table] ?? []) {
      const pair = cols[c];
      if (pair !== undefined && present(pair[1])) {
        state_to = String(pair[1]);
        if (present(pair[0])) state_from = String(pair[0]);
        break;
      }
    }
    const kind = cols['kind']?.[1];
    const a = amount.get(e);
    const entry: RichEntry = {
      at: e.occurred_at,
      seq: e.seq,
      event_type: e.event_type,
      words_key: wordsKeyOf(
        e.event_type,
        state_to ?? null,
        e.source_table === 'access_events' && typeof kind === 'string' ? kind : null,
      ),
      actor: { kind: e.actor_kind, label: KIND_WORDS[e.actor_kind] },
      channel: e.channel ?? NO_CHANNEL,
      source: { table: e.source_table, id: e.source_id },
      verified: e.verified,
      chain_key: e.chain_key,
      actor_id: e.actor_id,
      req_id: e.req_id,
      ip_hash: e.ip_hash,
      ua_family: e.ua_family,
      api_key_id: e.api_key_id,
      mfa: e.mfa,
      job: e.job,
      tool: e.tool,
      details: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v[1]])),
      raw: { on_behalf_of: e.on_behalf_of, unit_id: e.unit_id, buyer_id: e.buyer_id },
    };
    if (a !== undefined) entry.amount_minor = a;
    if (state_from !== undefined) entry.state_from = state_from;
    if (state_to !== undefined) entry.state_to = state_to;
    return entry;
  });
}
