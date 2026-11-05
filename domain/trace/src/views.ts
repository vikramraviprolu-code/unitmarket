// INT-TR1 / TR1.2: who sees what. This file is the only place a persona's rules live. The buyer sees the
// steps of an order that is theirs; the seller sees the steps of one unit that is theirs and nothing of the
// buyer or of another seller; the operator sees every step, with identity only on a session that has the
// second factor (operatorView, the one redaction function). A caller outside this file never reads the
// journal for a persona.
import type {
  OpsTimelineAnswer,
  OpsTimelineEntry,
  SqlExecutor,
  TimelineAnswer,
  TimelineEntry,
} from '@umsbx/contracts';
import type { ActorKind } from './kinds';
import { findOrder, findUnit, loadOrderEvents, loadUnitEvents, toRichEntries } from './timeline';
import type { RichEntry } from './timeline';

/** The source tables a buyer may see steps of: their order, their items, their money back, their access. */
export const BUYER_TABLES: readonly string[] = [
  'orders',
  'order_units',
  'refund_requests',
  'receipts',
  'entitlements',
  'access_windows',
  'links',
  'access_events',
  'recovery_cases',
  'mandate_reservations',
];

/** The source tables a seller may see steps of: the unit, its money lines and the access to it. */
export const SELLER_TABLES: readonly string[] = [
  'orders',
  'order_units',
  'refund_requests',
  'ledger_entries',
  'entitlements',
  'access_windows',
  'links',
  'access_events',
];

const last4 = (s: string | null): string => (s === null ? '' : s.slice(-4));

const plain = (e: RichEntry): TimelineEntry => {
  const out: TimelineEntry = {
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
};

// ---------------------------------------------------------------------------------------------------------
// Buyer

function buyerActor(e: RichEntry): { kind: ActorKind; label: string } {
  switch (e.actor.kind) {
    case 'buyer':
    case 'api_client':
      return { kind: 'buyer', label: 'You' };
    case 'agent':
      return { kind: 'agent', label: `Your agent (key …${last4(e.actor_id ?? e.api_key_id)})` };
    case 'publisher':
      return { kind: 'publisher', label: 'The seller' };
    case 'paypal':
      return { kind: 'paypal', label: 'PayPal' };
    default:
      return { kind: 'system', label: 'UnitMarket' };
  }
}

/** The steps of one order for the buyer who owns it. Null (never "forbidden") for anyone else. */
export async function buyerTimeline(
  db: SqlExecutor,
  o: { order_ref: string; buyer_id: string },
): Promise<TimelineAnswer | null> {
  const order = await findOrder(db, o.order_ref);
  if (order === null || order.buyer_id !== o.buyer_id) return null;
  const { events, truncated } = await loadOrderEvents(db, order.id, BUYER_TABLES);
  const entries = toRichEntries(events).map((e) => ({ ...plain(e), actor: buyerActor(e) }));
  return { entries, truncated };
}

// ---------------------------------------------------------------------------------------------------------
// Seller

function sellerActor(e: RichEntry): { kind: ActorKind; label: string } {
  switch (e.actor.kind) {
    case 'buyer':
    case 'api_client':
      return { kind: 'buyer', label: 'Buyer' };
    case 'agent':
      return { kind: 'agent', label: "Buyer's agent" };
    case 'publisher':
      return { kind: 'publisher', label: 'Seller' };
    case 'paypal':
      return { kind: 'paypal', label: 'PayPal' };
    default:
      return { kind: 'system', label: 'UnitMarket' };
  }
}

/**
 * The steps of one unit for the seller who sold it. The order's own steps are rewritten to name only this
 * unit and carry no amount: the order total and the other units are never shown. Null for any other seller.
 */
export async function sellerTimeline(
  db: SqlExecutor,
  o: { unit_id: string; publisher_id: string },
): Promise<TimelineAnswer | null> {
  const unit = await findUnit(db, o.unit_id);
  if (unit === null || unit.publisher_id !== o.publisher_id) return null;
  const { events, truncated } = await loadUnitEvents(db, unit.order_id, unit.id, SELLER_TABLES);
  const entries = toRichEntries(events).map((e): TimelineEntry => {
    const base = { ...plain(e), actor: sellerActor(e) };
    if (e.source.table !== 'orders') return base;
    const { amount_minor, ...rest } = base;
    void amount_minor;
    return { ...rest, source: { table: 'order_units', id: unit.id } };
  });
  return { entries, truncated };
}

// ---------------------------------------------------------------------------------------------------------
// Operator

/** Columns that hold an id PayPal gave. Without the second factor only "…" and the last four show. */
const PROVIDER_ID_COLUMNS = new Set([
  'provider_order_id',
  'capture_id',
  'refund_id',
  'debug_id',
  'event_id',
]);
const maskId = (v: unknown): unknown =>
  typeof v === 'string' ? (v.length <= 4 ? '…' : `…${v.slice(-4)}`) : v;

/** Without the second factor, no column that names a buyer, a seller, an operator, a request or a key. */
const IDENTITY_COLUMNS = new Set([
  'buyer_id',
  'publisher_id',
  'operator_id',
  'api_key_id',
  'req_id',
]);
const isIdentityDetail = (k: string, v: unknown): boolean =>
  IDENTITY_COLUMNS.has(k) || (typeof v === 'string' && /^(buy|pub|req)_/.test(v));

export type OperatorInput = Omit<RichEntry, 'chain_key' | 'raw'> & {
  chain_key?: string;
  raw?: RichEntry['raw'];
};

/**
 * The one redaction of the operator view. Without the second factor (an operator key, or a session without
 * the code): actor kind, channel, job and tool; an actor id only for system and operator; provider ids as
 * "…" and the last four; no request id, address, family, key or mfa flag. With it: all of those, the address
 * cut to its first 8 characters.
 */
export function operatorView(
  entries: readonly OperatorInput[],
  o: { mfa: boolean },
): OpsTimelineEntry[] {
  return entries.map((e): OpsTimelineEntry => {
    const out: OpsTimelineEntry = { ...plain(e as RichEntry), job: e.job, tool: e.tool };
    if (e.chain_key !== undefined) out.chain_key = e.chain_key;
    out.details = Object.fromEntries(
      Object.entries(e.details)
        .filter(([k, v]) => o.mfa || !isIdentityDetail(k, v))
        .map(([k, v]) => [k, !o.mfa && PROVIDER_ID_COLUMNS.has(k) ? maskId(v) : v]),
    );
    if (e.actor_id !== null && (o.mfa || e.actor.kind === 'system' || e.actor.kind === 'operator'))
      out.actor_id = e.actor_id;
    if (o.mfa) {
      out.req_id = e.req_id;
      out.ip_hash = e.ip_hash === null ? null : e.ip_hash.slice(0, 8);
      out.ua_family = e.ua_family;
      out.api_key_id = e.api_key_id;
      out.mfa = e.mfa;
    }
    return out;
  });
}

/** Every step of one order for an operator. `mfa` is true only for a session signed in with the code. */
export async function opsTimeline(
  db: SqlExecutor,
  o: { order_ref: string; mfa: boolean },
): Promise<OpsTimelineAnswer | null> {
  const order = await findOrder(db, o.order_ref);
  if (order === null) return null;
  const { events, truncated } = await loadOrderEvents(db, order.id);
  return { entries: operatorView(toRichEntries(events), { mfa: o.mfa }), truncated };
}
