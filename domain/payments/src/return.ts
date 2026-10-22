// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/checkout.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P3: onBuyerReturn (journey steps 9 to 14). The return is a trigger, never evidence: the stored
// provider order id is used and none from the URL (P6). Read before capturing; a mismatch freezes
// the order with nothing charged; delivery readiness is checked before any charge; one gated
// capture; the claim is stored; a separate read-back decides everything else.
import { applyMoneyEvent, getEntitlementForBuyer } from '@umsbx/entitlements';
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Id, PaymentsDeps, Result, SqlExecutor } from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { applyReadback, ensureReadbackOp, readApplyGates } from './apply';
import { captureOnce } from './capture';
import { matchReadback } from './match';
import {
  claimsOf,
  foreignCaptureIds,
  loadOrder,
  loadOrderByRef,
  loadProviderOrders,
  loadUnits,
} from './store';
import type { OrderRow, UnitRow } from './store';
import type { OrderView } from './types';

type ReturnError = {
  code:
    'not_found' | 'not_approved' | 'frozen' | 'not_charged_content_unavailable' | 'payments_paused';
};

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
  const provider = (await loadProviderOrders(d.db, order.id))[0];
  if (provider === undefined || provider.provider_order_id === null) {
    return err({ code: 'not_approved' });
  }
  const provider_order_id = provider.provider_order_id;

  // 1. Pre-capture read of the order, with the stored provider id only.
  const read = await d.paypal.getOrder(provider_order_id, scenario);
  if (read.kind === 'blocked') return err({ code: 'payments_paused' });
  if (read.kind !== 'order' || read.status !== 'APPROVED') {
    // Not capturable now. A parallel return may have captured it a moment ago: then the database,
    // not this read, tells the buyer where the order stands.
    const current = await loadOrder(d.db, order.id);
    if (current !== null && current.status !== 'awaiting_buyer') {
      return current.status === 'frozen'
        ? err({ code: 'frozen' })
        : ok(await loadOrderView(d.db, order.id));
    }
    return err({ code: 'not_approved' });
  }

  // 2. Pre-capture check with empty claims: any difference freezes the order; nothing is captured.
  const units = await loadUnits(d.db, order.id);
  const match = matchReadback({
    expected: order.expected,
    read,
    provider_order_id,
    claims: claimsOf(units).map((c) => ({ ...c, capture_id: null, claimed_at: null })),
    foreign_capture_ids: await foreignCaptureIds(
      d.db,
      order.id,
      read.units.map((u) => (u.capture === null ? null : u.capture.capture_id)),
    ),
  });
  const orderField = match.level === 'order' ? match.field : null;
  const badUnits =
    match.level === 'units' ? match.units.filter((u) => u.result !== 'no_capture') : [];
  if (orderField !== null || badUnits.length > 0) {
    await d.db.transaction(async (tx) => {
      const at = d.clock.now().toISOString();
      await tx.query(
        "UPDATE orders SET status = 'frozen', mismatch = true, updated_at = $2 WHERE id = $1 AND status = 'awaiting_buyer'",
        [order.id, at],
      );
      if (orderField !== null) {
        await raiseAlert(tx, d, {
          kind: 'frozen_order',
          order_id: order.id,
          unit_id: null,
          reason: `precapture_${orderField}`,
          detail: { field: orderField, phase: 'pre_capture' },
        });
      }
      for (const bad of badUnits) {
        const unit = units.find((u) => u.reference_id === bad.reference_id);
        if (unit === undefined) continue;
        const field =
          bad.result === 'mismatch' ? (bad.field ?? 'unknown') : 'capture_before_capture';
        await tx.query(
          "UPDATE order_units SET status = 'mismatch', mismatch_reason = $2, updated_at = $3 WHERE id = $1 AND captured_verified_at IS NULL",
          [unit.id, field, at],
        );
        await raiseAlert(tx, d, {
          kind: 'frozen_order',
          order_id: order.id,
          unit_id: unit.id,
          reason: `precapture_unit_${field}`,
          detail: { field, phase: 'pre_capture' },
        });
      }
    });
    return err({ code: 'frozen' });
  }

  // 3. Delivery readiness before charging, for every item (A-17). Outside any transaction.
  const gates = await readApplyGates(d, order.id);
  if (gates.not_ready.length > 0) {
    await d.db.transaction(async (tx) => {
      const at = d.clock.now().toISOString();
      const failed = await tx.query(
        "UPDATE orders SET status = 'failed', updated_at = $2 WHERE id = $1 AND status = 'awaiting_buyer' RETURNING id",
        [order.id, at],
      );
      if (failed.rows.length === 0) return;
      for (const unit of units) {
        await tx.query(
          "UPDATE order_units SET status = 'declined', status_reason = 'content_unavailable', updated_at = $2 WHERE id = $1",
          [unit.id, at],
        );
        const ents = await tx.query<{ id: string }>(
          'SELECT id FROM entitlements WHERE unit_id = $1 ORDER BY article_id',
          [unit.id],
        );
        for (const e of ents.rows) {
          await applyMoneyEvent(tx, d, { entitlement_id: e.id, event: 'declined' });
        }
      }
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
    return err({ code: 'not_charged_content_unavailable' });
  }

  // 4. The one gated capture.
  const outcome = await captureOnce(d, order, provider_order_id, scenario);
  switch (outcome.kind) {
    case 'lost':
    case 'unknown':
      return ok(await loadOrderView(d.db, order.id));
    case 'not_approved':
      return err({ code: 'not_approved' });
    case 'frozen':
      return err({ code: 'frozen' });
    case 'payer_action':
      return ok(await loadOrderView(d.db, order.id));
    case 'claim':
    case 'read_decides':
      break;
  }

  // 5. A separate read of the order; the claim never unlocks anything by itself.
  const after = await d.paypal.getOrder(provider_order_id, scenario);
  if (after.kind !== 'order') {
    await d.db.transaction(async (tx) => {
      const at = d.clock.now().toISOString();
      const current = await loadOrder(tx, order.id, { lock: true });
      if (current === null) return;
      if (current.status === 'capture_requested' || current.status === 'capture_claimed') {
        await tx.query("UPDATE orders SET status = 'unresolved', updated_at = $2 WHERE id = $1", [
          order.id,
          at,
        ]);
      }
      await ensureReadbackOp(tx, d, current, at);
    });
    return ok(await loadOrderView(d.db, order.id));
  }
  const postGates = await readApplyGates(d, order.id);
  await d.db.transaction((tx) =>
    applyReadback(tx, d, { order_id: order.id, read: after, trigger: 'capture', gates: postGates }),
  );
  return ok(await loadOrderView(d.db, order.id));
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
  const ids = await db.query<{ id: string; article_id: string }>(
    `SELECT e.id, e.article_id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
      WHERE u.order_id = $1 ORDER BY e.article_id, e.id`,
    [order.id],
  );
  const items: OrderView['items'] = [];
  const money: string[] = [];
  for (const e of ids.rows) {
    const v = await getEntitlementForBuyer(db, { entitlement_id: e.id, buyer_id: order.buyer_id });
    if (v === null) continue;
    items.push({ article_id: v.article_id, access: v.access, window: v.window });
    money.push(v.money);
  }
  const provider = (await loadProviderOrders(db, order.id))[0];
  return {
    order_id: order.id,
    order_ref: order.order_ref,
    status: order.status,
    buyer_message: messageFor(order, units, items, money),
    items,
    environment: order.environment,
    approve_url: order.status === 'awaiting_buyer' ? (provider?.approve_url ?? null) : null,
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
      return pending === undefined
        ? 'Confirming payment'
        : `Payment pending at PayPal: ${pending.status_reason ?? 'waiting for PayPal'}`;
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
