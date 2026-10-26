// MVP-D (DP-2a), route D2: one PayPal order per publisher, each with its own state.
// The rules here are the ones in docs/specs/mvp-d-overview.md section 3. deriveOrderStatus and
// expectedFor are pure; the helpers below them write inside the caller's transaction and expect
// the caller to hold the order rows (lockOrderRows / lockOrderGraph), never to take them late.
import { ExpectedTransactionSchema } from '@umsbx/contracts';
import type { CoreDeps, ExpectedTransaction, Id, OrderStatus, SqlExecutor } from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { loadOrder, loadProviderOrders, lockOrderRows } from './store';
import type { OrderRow, ProviderOrderRow } from './store';

export const PROVIDER_ORDER_STATES = [
  'prepared',
  'awaiting_buyer',
  'approved',
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'captured',
  'declined',
  'frozen',
  'failed',
  'abandoned',
] as const;
export type ProviderOrderState = (typeof PROVIDER_ORDER_STATES)[number];

/** Nothing more happens to a PayPal order in one of these states. */
export const TERMINAL_STATES: ReadonlySet<ProviderOrderState> = new Set([
  'captured',
  'declined',
  'frozen',
  'failed',
  'abandoned',
]);
/** "Not charged": PayPal declined it, or we failed or abandoned it. `frozen` is on hold, not this. */
export const NOT_CHARGED_STATES: ReadonlySet<ProviderOrderState> = new Set([
  'declined',
  'failed',
  'abandoned',
]);
/** A capture was sent for a PayPal order in one of these states, whatever the operation row says. */
const IMPLIES_SENT: ReadonlySet<ProviderOrderState> = new Set([
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'captured',
]);
/** Before the buyer approved, or approved and not yet sent: `first_sent_at` alone proves nothing. */
const NOT_SENT_BY_FLAG: ReadonlySet<ProviderOrderState> = new Set([
  'prepared',
  'awaiting_buyer',
  'approved',
]);

export interface PoFacts {
  state: ProviderOrderState;
  /** The PayPal order's own capture operation has first_sent_at. */
  capture_first_sent: boolean;
  /** Some unit of this PayPal order is not verified (only meaningful for `captured`). */
  partial?: boolean;
}
export interface Derived {
  status: OrderStatus;
  /** True whenever any PayPal order is frozen. */
  mismatch: boolean;
  /** How many PayPal orders are declined, failed or abandoned. */
  not_charged: number;
}

/**
 * The status of the order, from its PayPal orders alone. Pure. The first rule that matches wins.
 * A PayPal order counts as SENT when its own capture operation has first_sent_at and its state is not
 * approved (a capture reopened after payer_action or ORDER_NOT_APPROVED keeps its first_sent_at but
 * is approved again, so it is not sent). Rule 1: every PayPal order is terminal. Rule 2: a capture was
 * sent and some PayPal order is not terminal. Rule 3: no capture sent.
 */
export function deriveOrderStatus(pos: readonly PoFacts[]): Derived {
  const has = (s: ProviderOrderState): boolean => pos.some((p) => p.state === s);
  const all = (s: ProviderOrderState): boolean => pos.every((p) => p.state === s);
  const mismatch = has('frozen');
  const not_charged = pos.filter((p) => NOT_CHARGED_STATES.has(p.state)).length;
  const out = (status: OrderStatus): Derived => ({ status, mismatch, not_charged });

  // Rule 1.
  if (pos.every((p) => TERMINAL_STATES.has(p.state))) {
    if (has('captured')) {
      return out(all('captured') && !pos.some((p) => p.partial === true) ? 'paid' : 'paid_partial');
    }
    if (has('frozen')) return out('frozen');
    if (all('abandoned')) return out('abandoned');
    return out('failed');
  }
  // Rule 2.
  const sent = pos.some(
    (p) => IMPLIES_SENT.has(p.state) || (p.capture_first_sent && !NOT_SENT_BY_FLAG.has(p.state)),
  );
  if (sent) {
    if (has('unresolved')) return out('unresolved');
    if (has('capture_claimed')) return out('capture_claimed');
    return out('capture_requested');
  }
  // Rule 3.
  if (has('frozen')) return out('frozen');
  if (has('failed')) return out('failed');
  if (has('abandoned')) return out('abandoned');
  if (has('prepared')) return out('created');
  return out('awaiting_buyer');
}

/** The reference of a PayPal order: the order_ref for a single order, <order_ref>-p<position> otherwise. */
export const poRefFor = (order_ref: Id, position: number, route: 'single' | 'per_publisher'): Id =>
  route === 'single' ? order_ref : `${order_ref}-p${position}`;

/**
 * The expected transaction of ONE PayPal order: the stored expected transaction cut down to the
 * units that sit on it, with the total of those. The whole order (every unit) is returned as stored.
 * Never rebuilt from anything PayPal says.
 */
export function expectedFor(
  expected: ExpectedTransaction,
  reference_ids: readonly Id[],
): ExpectedTransaction {
  const wanted = new Set(reference_ids);
  if (wanted.size === 0) throw new RangeError('expectedFor: no units');
  const units = expected.units.filter((u) => wanted.has(u.reference_id));
  if (units.length !== wanted.size) throw new RangeError('expectedFor: unknown unit');
  if (units.length === expected.units.length) return expected;
  return ExpectedTransactionSchema.parse({
    ...expected,
    units,
    total_minor: units.reduce((n, u) => n + u.amount_minor, 0),
  });
}

// ---------------------------------------------------------------------------------------------
// Writes (inside the caller's transaction, rows already locked)

export interface OrderGraph {
  order: OrderRow;
  pos: ProviderOrderRow[];
}

/**
 * Lock the order, its PayPal orders by position and its operations (lockOrderRows), then read the
 * PayPal orders. For a single-route order whose status was moved by a writer that still works on
 * orders.status alone (reconcile, the due pass, recovery, webhooks: DP-2b), the one provider order
 * is brought in line with the order first, with the mapping 0011 uses for old rows. Per-publisher
 * orders are never touched here.
 */
export async function lockOrderGraph(tx: SqlExecutor, order_id: Id): Promise<OrderGraph | null> {
  const order = await lockOrderRows(tx, order_id);
  if (order === null) return null;
  let pos = await loadProviderOrders(tx, order_id);
  const only = pos[0];
  if (pos.length === 1 && only !== undefined && only.route === 'single') {
    const target = legacyState(order.status, only.state);
    if (target !== null) {
      await tx.query('UPDATE provider_orders SET state = $2 WHERE id = $1', [only.id, target]);
      pos = await loadProviderOrders(tx, order_id);
    }
  }
  return { order, pos };
}

/** lockOrderGraph for a transaction whose order must exist (it was read a moment ago): throws if it is gone. */
export async function lockGraph(tx: SqlExecutor, order_id: Id): Promise<OrderGraph> {
  const graph = await lockOrderGraph(tx, order_id);
  if (graph === null) throw new Error(`unknown order ${order_id}`);
  return graph;
}

/** One PayPal order of a locked graph, by id; throws if it is not there. */
export function poIn(graph: OrderGraph, id: Id): ProviderOrderRow {
  const po = graph.pos.find((p) => p.id === id);
  if (po === undefined) throw new Error(`provider order ${id} vanished`);
  return po;
}

/** The state a single-route PayPal order must have when the order status says `status`, or null if it already agrees. */
function legacyState(status: OrderStatus, now: ProviderOrderState): ProviderOrderState | null {
  const set = (s: ProviderOrderState): ProviderOrderState | null => (s === now ? null : s);
  switch (status) {
    case 'created':
      return null;
    case 'awaiting_buyer':
      if (now === 'prepared') return 'awaiting_buyer';
      return now === 'capture_requested' || now === 'capture_claimed' || now === 'unresolved'
        ? 'approved'
        : null;
    case 'capture_requested':
    case 'capture_claimed':
    case 'unresolved':
      return set(status);
    case 'paid':
    case 'paid_partial':
      return set('captured');
    case 'failed':
      return now === 'failed' || now === 'declined' ? null : 'failed';
    case 'abandoned':
      return set('abandoned');
    case 'frozen':
      return set('frozen');
  }
}

/** Facts for deriveOrderStatus, read in the caller's transaction. */
export async function poFacts(tx: SqlExecutor, order_id: Id): Promise<(PoFacts & { id: Id })[]> {
  const found = await tx.query<{
    id: string;
    state: ProviderOrderState;
    sent: boolean;
    partial: boolean;
  }>(
    `SELECT p.id, p.state,
            EXISTS (SELECT 1 FROM operations o
                     WHERE o.order_id = p.order_id AND o.kind = 'capture' AND o.first_sent_at IS NOT NULL
                       AND (o.provider_order_ref = p.id OR (p.route = 'single' AND o.provider_order_ref IS NULL))) AS sent,
            EXISTS (SELECT 1 FROM order_units u
                     WHERE u.provider_order_ref = p.id AND u.captured_verified_at IS NULL) AS partial
       FROM provider_orders p WHERE p.order_id = $1 ORDER BY p.position`,
    [order_id],
  );
  return found.rows.map((r) => ({
    id: r.id,
    state: r.state,
    capture_first_sent: r.sent,
    partial: r.partial,
  }));
}

/**
 * Set orders.status (and the mismatch flag) from the PayPal orders, and nothing else may set it.
 * partial_composite is raised only on ENTERING paid_partial with at least one PayPal order not
 * charged; a frozen PayPal order is on hold and never counts as not charged.
 */
export async function refreshOrder(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock' | 'ids'>,
  order_id: Id,
): Promise<{ status: OrderStatus; before: OrderStatus; derived: Derived }> {
  const order = await loadOrder(tx, order_id);
  if (order === null) throw new Error(`refreshOrder: unknown order ${order_id}`);
  const derived = deriveOrderStatus(await poFacts(tx, order_id));
  if (derived.status !== order.status || (derived.mismatch && !order.mismatch)) {
    await tx.query(
      'UPDATE orders SET status = $2, mismatch = mismatch OR $3, updated_at = $4 WHERE id = $1',
      [order_id, derived.status, derived.mismatch, d.clock.now().toISOString()],
    );
  }
  if (
    derived.status === 'paid_partial' &&
    order.status !== 'paid_partial' &&
    derived.not_charged > 0
  ) {
    await raiseAlert(tx, d, {
      kind: 'partial_composite',
      order_id,
      unit_id: null,
      reason: 'partial',
      detail: { not_charged: derived.not_charged },
    });
  }
  return { status: derived.status, before: order.status, derived };
}

/**
 * Move one PayPal order to `state`, only from one of the states in `from`. True when it moved. The
 * order status is not touched; call refreshOrder.
 */
export async function setPoState(
  tx: SqlExecutor,
  po_id: Id,
  state: ProviderOrderState,
  at: string,
  from: readonly ProviderOrderState[],
): Promise<boolean> {
  const done = await tx.query(
    'UPDATE provider_orders SET state = $2, updated_at = $3 WHERE id = $1 AND state = ANY($4::text[]) RETURNING id',
    [po_id, state, at, [...from]],
  );
  return done.rows.length > 0;
}

const OPEN_STATES: ProviderOrderState[] = PROVIDER_ORDER_STATES.filter(
  (s) => !TERMINAL_STATES.has(s),
);

/**
 * A whole-order outcome (M-A): a create rejected, a duplicate at create, a pass mismatch, an item not
 * ready, a lapsed order, a pack abandon. The same terminal state goes to EVERY PayPal order of the order
 * that is not terminal, in the caller's transaction, so the order status never sees a held PayPal order
 * beside a waiting one. Returns the PayPal orders that moved.
 */
export async function endWholeOrder(
  tx: SqlExecutor,
  d: Pick<CoreDeps, 'clock' | 'ids'>,
  order_id: Id,
  state: 'frozen' | 'failed' | 'abandoned',
): Promise<Id[]> {
  const at = d.clock.now().toISOString();
  const moved = await tx.query<{ id: string }>(
    `UPDATE provider_orders SET state = $2, updated_at = $3
      WHERE order_id = $1 AND state = ANY($4::text[]) RETURNING id`,
    [order_id, state, at, OPEN_STATES],
  );
  await refreshOrder(tx, d, order_id);
  return moved.rows.map((r) => r.id);
}
