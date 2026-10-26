// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/checkout.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P3: onBuyerReturn (journey steps 9 to 14). The return is a trigger, never evidence: the stored
// provider order id is used and none from the URL (P6). Read before capturing; a mismatch freezes
// the order with nothing charged; delivery readiness is checked before any charge; one gated
// capture; the claim is stored; a separate read-back decides everything else.
// MVP-D (DP-2a): an order is one PayPal order (single) or one per publisher (a pack). Every awaiting
// PayPal order is read by its stored id; nothing is captured until every one is approved; one pass
// reads and matches every PayPal order before the first capture; then each approved PayPal order is
// captured in position order, with its own key, and read back on its own.
import { getEntitlementForBuyer } from '@umsbx/entitlements';
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Id, OrderRead, PaymentsDeps, Result, SqlExecutor } from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { applyReadback, declineUnits, ensureReadbackOp, readApplyGates } from './apply';
import { captureOnce, claimPrecheck, reasonFor, releasePrecheck } from './capture';
import { nextApproval } from './checkout';
import {
  endWholeOrder,
  expectedFor,
  lockGraph,
  lockOrderGraph,
  poIn,
  refreshOrder,
  setPoState,
} from './composite';
import { matchReadback } from './match';
import {
  claimsOf,
  foreignCaptureIds,
  loadOrder,
  loadOrderByRef,
  loadProviderOrders,
  loadUnits,
  unitsOf,
} from './store';
import type { OrderRow, ProviderOrderRow, UnitRow } from './store';
import type { OrderView } from './types';

type ReturnError = {
  code:
    'not_found' | 'not_approved' | 'frozen' | 'not_charged_content_unavailable' | 'payments_paused';
};
type Answer = Result<OrderView, ReturnError>;
type Read = OrderRead;

const PACK_WINDOW_DEFAULT_MS = 3_600_000;

export async function onBuyerReturn(
  d: PaymentsDeps,
  i: { order_ref: Id; actor: Actor; scenario?: string | null },
): Promise<Result<OrderView, ReturnError>> {
  const scenario = i.scenario ?? null;
  if (i.actor.kind !== 'buyer') return err({ code: 'not_found' });
  // A malformed reference names no order (and a NUL character would make PostgreSQL throw).
  if (!IdSchema.safeParse(i.order_ref).success) return err({ code: 'not_found' });
  const order = await loadOrderByRef(d.db, i.order_ref, i.actor.buyer_id);
  if (order === null) return err({ code: 'not_found' });

  // Everything but "awaiting the buyer" is answered from the database: a second return never
  // reads, never captures (the reconciler of lane 05b owns the orders that are in flight).
  if (order.status === 'frozen') return err({ code: 'frozen' });
  if (order.status === 'created') return err({ code: 'not_approved' });
  if (order.status !== 'awaiting_buyer') {
    const view = await loadOrderView(d.db, order.id);
    if (await contentUnavailable(d.db, order)) {
      return err({ code: 'not_charged_content_unavailable' });
    }
    return ok(view);
  }

  // The switch is read outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('checkout_enabled'))) return err({ code: 'payments_paused' });
  // The PayPal orders as the engine sees them (a single order moved by an older writer is brought in line).
  const pos = await d.db.transaction(async (tx) => (await lockOrderGraph(tx, order.id))?.pos ?? []);
  const lease = pos[0];
  if (lease === undefined || pos.some((p) => p.provider_order_id === null)) {
    return err({ code: 'not_approved' });
  }

  // An order flagged mismatch, or with a unit in mismatch, is never captured, whatever the order
  // status says now (H1): the flag is a fact a human must clear.
  const flagged = await loadUnits(d.db, order.id);
  if (order.mismatch || flagged.some((u) => u.status === 'mismatch')) {
    await d.db.transaction(async (tx) => {
      const graph = await lockGraph(tx, order.id);
      if (graph.order.status !== 'awaiting_buyer') return;
      await endWholeOrder(tx, d, order.id, 'frozen');
      await raiseAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: null,
        reason: 'return_on_flagged_order',
        detail: { phase: 'pre_capture' },
      });
    });
    return err({ code: 'frozen' });
  }

  // The pre-gate: one of many concurrent returns reads; the others answer from the database.
  if (!(await claimPrecheck(d, order, lease))) return ok(await loadOrderView(d.db, order.id));
  // The lease is always given back: it only touches a capture operation that is still `prepared`, and
  // one that was sent or settled has nothing to release.
  try {
    return await settle(d, order, scenario);
  } finally {
    await releasePrecheck(d, order, lease);
  }
}

const isApproved = (r: Read): boolean => r.kind === 'order' && r.status === 'APPROVED';
const hasCapture = (r: Read): boolean =>
  r.kind === 'order' && r.units.some((u) => u.capture !== null);

async function readOf(
  d: PaymentsDeps,
  po: ProviderOrderRow,
  scenario: string | null,
): Promise<Read> {
  return d.paypal.getOrder(po.provider_order_id as string, scenario);
}

/**
 * Steps 1 to 4 of the return, for every PayPal order of the order: read the ones awaiting the buyer
 * (step A), wait or abandon while one is still unapproved (B), the pass over all of them before the
 * first capture (C), then the gated captures and read-backs in position order (D).
 */
async function settle(d: PaymentsDeps, order: OrderRow, scenario: string | null): Promise<Answer> {
  const view = async (): Promise<Answer> => ok(await loadOrderView(d.db, order.id));
  const fail = (code: ReturnError['code']): Answer => err({ code });
  const reload = async (): Promise<ProviderOrderRow[]> => loadProviderOrders(d.db, order.id);
  let pos = await reload();
  const single = pos.length === 1;
  const reads = new Map<Id, Read>();

  // A. Every PayPal order awaiting the buyer is read by its stored id. An APPROVED read moves it to
  // approved; the first approval sets first_approved_at (when WE first saw it).
  for (const po of pos) {
    if (po.state === 'awaiting_buyer') reads.set(po.id, await readOf(d, po, scenario));
  }
  if ([...reads.values()].some((r) => r.kind === 'blocked')) return fail('payments_paused');
  const nowApproved = pos.filter(
    (p) => p.state === 'awaiting_buyer' && isApproved(reads.get(p.id)!),
  );
  if (nowApproved.length > 0) {
    await d.db.transaction(async (tx) => {
      await lockGraph(tx, order.id);
      const at = d.clock.now().toISOString();
      for (const po of nowApproved) {
        if (await setPoState(tx, po.id, 'approved', at, ['awaiting_buyer'])) {
          await tx.query(
            `UPDATE provider_orders SET first_approved_at = COALESCE(first_approved_at, $2), status = 'APPROVED' WHERE id = $1`,
            [po.id, at],
          );
        }
      }
      await refreshOrder(tx, d, order.id);
    });
    pos = await reload();
  }

  // B. Some PayPal order is still awaiting the buyer.
  const waiting = pos.filter((p) => p.state === 'awaiting_buyer');
  if (waiting.length > 0) {
    if (single) {
      // Not capturable now. A parallel return may have captured it a moment ago: then the database,
      // not this read, tells the buyer where the order stands.
      const current = await loadOrder(d.db, order.id);
      if (current !== null && current.status !== 'awaiting_buyer') {
        return current.status === 'frozen' ? fail('frozen') : view();
      }
      return fail('not_approved');
    }
    const first = pos
      .map((p) => (p.first_approved_at === null ? null : Date.parse(p.first_approved_at)))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b)[0];
    const window = d.config.pack_approval_window_ms ?? PACK_WINDOW_DEFAULT_MS;
    if (first !== undefined && Date.parse(d.clock.now().toISOString()) >= first + window) {
      // The window is over: every PayPal order is read. All APPROVED would go on to capture (P17);
      // otherwise the whole pack is abandoned and nothing is charged.
      for (const po of pos) if (!reads.has(po.id)) reads.set(po.id, await readOf(d, po, scenario));
      if ([...reads.values()].some((r) => r.kind === 'blocked')) return fail('payments_paused');
      const definite = (r: Read): boolean => r.kind === 'order' || r.kind === 'not_found';
      if (
        waiting.every((p) => definite(reads.get(p.id)!)) &&
        !pos.every((p) => isApproved(reads.get(p.id)!))
      ) {
        await abandonPack(d, order);
        return view();
      }
      if (!pos.every((p) => isApproved(reads.get(p.id)!))) return view();
    } else {
      return view();
    }
  }

  // C. The pass: every PayPal order is read (those not read yet) and matched against its own slice,
  // and every item is checked for readiness, before the first capture.
  for (const po of pos) if (!reads.has(po.id)) reads.set(po.id, await readOf(d, po, scenario));
  if ([...reads.values()].some((r) => r.kind === 'blocked')) return fail('payments_paused');
  const allUnits = await loadUnits(d.db, order.id);
  const orderFields: { po: ProviderOrderRow; field: string }[] = [];
  const badUnits: { po: ProviderOrderRow; unit: UnitRow; field: string }[] = [];
  for (const po of pos) {
    const read = reads.get(po.id)!;
    if (read.kind !== 'order' || read.status !== 'APPROVED') continue;
    const mine = unitsOf(allUnits, po);
    const match = matchReadback({
      expected: expectedFor(
        order.expected,
        mine.map((u) => u.reference_id),
      ),
      read,
      provider_order_id: po.provider_order_id as string,
      claims: claimsOf(mine).map((c) => ({ ...c, capture_id: null, claimed_at: null })),
      foreign_capture_ids: await foreignCaptureIds(
        d.db,
        order.id,
        read.units.map((u) => (u.capture === null ? null : u.capture.capture_id)),
        mine.map((u) => u.id),
      ),
    });
    if (match.level === 'order') orderFields.push({ po, field: match.field });
    else {
      for (const u of match.units.filter((x) => x.result !== 'no_capture')) {
        const unit = mine.find((x) => x.reference_id === u.reference_id);
        if (unit !== undefined) {
          badUnits.push({
            po,
            unit,
            field: u.result === 'mismatch' ? (u.field ?? 'unknown') : 'capture_before_capture',
          });
        }
      }
    }
  }
  if (orderFields.length > 0 || badUnits.length > 0) {
    // Any mismatch freezes the whole order; nothing is captured (a whole-order outcome).
    await d.db.transaction(async (tx) => {
      await lockGraph(tx, order.id);
      const at = d.clock.now().toISOString();
      await endWholeOrder(tx, d, order.id, 'frozen');
      for (const o of orderFields) {
        await raiseAlert(tx, d, {
          kind: 'frozen_order',
          order_id: order.id,
          unit_id: null,
          reason: reasonFor(o.po, `precapture_${o.field}`),
          detail: { field: o.field, phase: 'pre_capture' },
        });
      }
      for (const bad of badUnits) {
        await tx.query(
          "UPDATE order_units SET status = 'mismatch', mismatch_reason = $2, updated_at = $3 WHERE id = $1 AND captured_verified_at IS NULL",
          [bad.unit.id, bad.field, at],
        );
        await raiseAlert(tx, d, {
          kind: 'frozen_order',
          order_id: order.id,
          unit_id: bad.unit.id,
          reason: `precapture_unit_${bad.field}`,
          detail: { field: bad.field, phase: 'pre_capture' },
        });
      }
    });
    return fail('frozen');
  }
  // A PayPal order that has lapsed (VOIDED, or not found, with no capture) abandons the whole pack:
  // nothing was captured, nothing is charged, and nobody is told it is on hold.
  const lapsed = (r: Read): boolean =>
    r.kind === 'not_found' || (r.kind === 'order' && r.status === 'VOIDED' && !hasCapture(r));
  if (!single && pos.some((p) => lapsed(reads.get(p.id)!))) {
    await abandonPack(d, order);
    return view();
  }
  // Not capturable now (an approval that went away, an unreadable order): back to the buyer.
  const unusable = pos.filter((p) => !isApproved(reads.get(p.id)!));
  if (unusable.length > 0) {
    const current = await loadOrder(d.db, order.id);
    if (current !== null && current.status !== 'awaiting_buyer') {
      return current.status === 'frozen' ? fail('frozen') : view();
    }
    await d.db.transaction(async (tx) => {
      await lockGraph(tx, order.id);
      const at = d.clock.now().toISOString();
      for (const po of unusable) {
        const r = reads.get(po.id)!;
        // The read is a real order that is simply not approved (any more): the buyer approves again.
        if (r.kind === 'order' && r.status !== 'VOIDED' && r.status !== 'COMPLETED') {
          await setPoState(tx, po.id, 'awaiting_buyer', at, ['approved']);
        }
      }
      await refreshOrder(tx, d, order.id);
    });
    return fail('not_approved');
  }

  // Delivery readiness before charging, for every item (A-17). Outside any transaction.
  const gates = await readApplyGates(d, order.id);
  if (gates.not_ready.length > 0) {
    await d.db.transaction(async (tx) => {
      const graph = await lockGraph(tx, order.id);
      if (graph.order.status !== 'awaiting_buyer') return;
      await endWholeOrder(tx, d, order.id, 'failed');
      await declineUnits(tx, d, order.id, 'content_unavailable');
      for (const n of gates.not_ready) {
        await raiseAlert(tx, d, {
          kind: 'content_unavailable',
          order_id: order.id,
          unit_id: null,
          reason: `precapture_${n.article_id}`,
          detail: { article_id: n.article_id, code: n.code },
        });
      }
    });
    return fail('not_charged_content_unavailable');
  }

  // D. The gated captures, in position order, each with its own key; each is read back on its own.
  let called = 0;
  for (const po of pos) {
    const first = called === 0;
    const stop = view;
    // A status-only read showing APPROVED: the pass read serves until something was captured; after
    // that a PayPal order is read again, and a problem holds that PayPal order only.
    let read = reads.get(po.id)!;
    if (!first) {
      read = await readOf(d, po, scenario);
      if (!isApproved(read)) return stop();
      const mine = unitsOf(allUnits, po);
      const m = matchReadback({
        expected: expectedFor(
          order.expected,
          mine.map((u) => u.reference_id),
        ),
        read: read as Extract<Read, { kind: 'order' }>,
        provider_order_id: po.provider_order_id as string,
        claims: claimsOf(mine).map((c) => ({ ...c, capture_id: null, claimed_at: null })),
        foreign_capture_ids: [],
      });
      const bad =
        m.level === 'order'
          ? [{ field: m.field, unit: null as UnitRow | null }]
          : m.units
              .filter((u) => u.result !== 'no_capture')
              .map((u) => ({
                field: u.result === 'mismatch' ? (u.field ?? 'unknown') : 'capture_before_capture',
                unit: mine.find((x) => x.reference_id === u.reference_id) ?? null,
              }));
      if (bad.length > 0) {
        await holdOne(d, order, po, bad);
        return stop();
      }
    }
    const outcome = await captureOnce(d, order, po.provider_order_id as string, scenario, po);
    if (outcome.kind !== 'lost' && outcome.kind !== 'capped') called += 1;
    switch (outcome.kind) {
      case 'lost':
        return first ? view() : stop();
      case 'capped':
        return first ? fail('not_approved') : stop();
      case 'blocked':
        return first ? fail('payments_paused') : stop();
      case 'unknown':
      case 'payer_action':
        return stop();
      case 'not_approved':
        return first ? fail('not_approved') : stop();
      case 'frozen':
        if (first && pos.length === 1) return fail('frozen');
        continue;
      case 'claim':
      case 'read_decides':
        break;
    }

    // A separate read of this PayPal order; the claim never unlocks anything by itself.
    const after = await readOf(d, po, scenario);
    if (after.kind !== 'order') {
      await d.db.transaction(async (tx) => {
        const at = d.clock.now().toISOString();
        const graph = await lockGraph(tx, order.id);
        const cur = poIn(graph, po.id);
        if (cur.state === 'capture_requested' || cur.state === 'capture_claimed') {
          await setPoState(tx, po.id, 'unresolved', at, [cur.state]);
          await refreshOrder(tx, d, order.id);
        }
        await ensureReadbackOp(tx, d, graph.order, at, cur);
      });
      return stop();
    }
    const postGates = await readApplyGates(d, order.id);
    const report = await d.db.transaction((tx) =>
      applyReadback(tx, d, {
        order_id: order.id,
        read: after,
        trigger: 'capture',
        gates: postGates,
        provider_order_ref: po.id,
      }),
    );
    void report;
    // An unresolved PayPal order is the reconciler's; the rest of the pack waits for the continuation.
    const now = (await reload()).find((p) => p.id === po.id);
    if (
      now?.state === 'unresolved' ||
      now?.state === 'capture_claimed' ||
      now?.state === 'capture_requested'
    ) {
      return stop();
    }
  }
  return view();
}

/** One PayPal order fails the check after another was captured: only that PayPal order is held. */
async function holdOne(
  d: PaymentsDeps,
  order: OrderRow,
  po: ProviderOrderRow,
  bad: { field: string; unit: UnitRow | null }[],
): Promise<void> {
  await d.db.transaction(async (tx) => {
    await lockGraph(tx, order.id);
    const at = d.clock.now().toISOString();
    await setPoState(tx, po.id, 'frozen', at, ['approved']);
    for (const b of bad) {
      if (b.unit !== null) {
        await tx.query(
          "UPDATE order_units SET status = 'mismatch', mismatch_reason = $2, updated_at = $3 WHERE id = $1 AND captured_verified_at IS NULL",
          [b.unit.id, b.field, at],
        );
      }
      await raiseAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: b.unit === null ? null : b.unit.id,
        reason:
          b.unit === null ? reasonFor(po, `precapture_${b.field}`) : `precapture_unit_${b.field}`,
        detail: { field: b.field, phase: 'pre_capture' },
      });
    }
    await refreshOrder(tx, d, order.id);
  });
}

/** The pack is abandoned: nothing was captured. Every open PayPal order is abandoned, in one transaction. */
async function abandonPack(d: PaymentsDeps, order: OrderRow): Promise<void> {
  await d.db.transaction(async (tx) => {
    const graph = await lockGraph(tx, order.id);
    if (graph.order.status !== 'awaiting_buyer') return;
    const at = d.clock.now().toISOString();
    await endWholeOrder(tx, d, order.id, 'abandoned');
    await declineUnits(tx, d, order.id, 'abandoned');
    await tx.query(
      `UPDATE operations SET state = 'failed', failure_reason = 'declined', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE order_id = $1 AND state = 'prepared'`,
      [order.id, at],
    );
  });
}

// ---------------------------------------------------------------------------------------------

async function contentUnavailable(db: SqlExecutor, order: OrderRow): Promise<boolean> {
  if (order.status !== 'failed') return false;
  const found = await db.query(
    "SELECT 1 FROM order_units WHERE order_id = $1 AND status_reason = 'content_unavailable' LIMIT 1",
    [order.id],
  );
  return found.rows.length > 0;
}

/** The order as the buyer may see it: states in plain words, never internals. */
export async function loadOrderView(db: SqlExecutor, order_id: Id): Promise<OrderView> {
  const order = await loadOrder(db, order_id);
  if (order === null) throw new Error(`loadOrderView: unknown order ${order_id}`);
  const units = await loadUnits(db, order.id);
  const ids = await db.query<{ id: string; article_id: string; publisher_id: string }>(
    `SELECT e.id, e.article_id, u.publisher_id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
      WHERE u.order_id = $1 ORDER BY e.article_id, e.id`,
    [order.id],
  );
  const items: OrderView['items'] = [];
  const money: string[] = [];
  for (const e of ids.rows) {
    const v = await getEntitlementForBuyer(db, { entitlement_id: e.id, buyer_id: order.buyer_id });
    if (v === null) continue;
    items.push({
      article_id: v.article_id,
      publisher_id: e.publisher_id,
      access: v.access,
      window: v.window,
    });
    money.push(v.money);
  }
  const pos = await loadProviderOrders(db, order.id);
  const next = order.status === 'awaiting_buyer' ? nextApproval(pos) : null;
  return {
    order_id: order.id,
    order_ref: order.order_ref,
    status: order.status,
    buyer_message: messageFor(order, units, items, money),
    operator_note:
      order.status === 'unresolved'
        ? (units.find((u) => u.status === 'pending')?.status_reason ?? null)
        : null,
    items,
    environment: order.environment,
    approve_url: next === null ? null : next.approve_url,
    progress: next === null || pos.length < 2 ? null : { step: next.po.position, of: pos.length },
    provider_orders: pos.map((p) => ({
      position: p.position,
      publisher_id: p.publisher_id,
      state: p.state,
    })),
  };
}

function messageFor(
  order: OrderRow,
  units: UnitRow[],
  items: OrderView['items'],
  money: string[],
): string {
  switch (order.status) {
    case 'created':
      return 'Preparing your payment';
    case 'awaiting_buyer':
      return 'Waiting for you at PayPal';
    case 'capture_requested':
    case 'capture_claimed':
      return 'Confirming payment';
    case 'unresolved': {
      const pending = units.find((u) => u.status === 'pending');
      return pending === undefined ? 'Confirming payment' : 'Payment pending at PayPal';
    }
    case 'paid':
    case 'paid_partial':
      return items.some((it, k) => money[k] === 'captured' && it.access === 'locked')
        ? 'Access paused'
        : 'Payment confirmed';
    case 'frozen':
      return 'We are checking this payment with PayPal';
    case 'abandoned':
      return 'Not charged';
    case 'failed':
      return units.some((u) => u.status_reason === 'content_unavailable')
        ? 'Not charged: content unavailable'
        : 'Payment was not completed. You were not charged';
  }
}
