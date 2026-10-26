// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/reconcile.ts (applyRead, settleMatched)
// at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P7 first bullet and P8: applyReadback. One read of the PayPal order is matched against the
// expected transaction written before the charge and applied in the caller's transaction: unit
// verified (compare-and-set), entitlement money captured, ledger sale and fee, access window
// started, receipt issued. A claim never gets here as evidence; only a read does. Nothing in this
// file calls the provider or any other port: the unlock switch and the delivery readiness probe are
// read by readApplyGates before the transaction and passed in.
import { markAccessReady } from '@umsbx/access-clock';
import { checkReadiness } from '@umsbx/delivery';
import { applyMoneyEvent } from '@umsbx/entitlements';
import { appendLedgerEntry } from '@umsbx/ledger';
import { issueReceiptIfChanged } from '@umsbx/receipts';
import { ApprovalSnapshotSchema } from '@umsbx/contracts';
import type { CoreDeps, Id, OrderRead, PaymentsDeps, SqlExecutor } from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { expectedFor, lockGraph, refreshOrder, setPoState } from './composite';
import type { ProviderOrderState } from './composite';
import { readbackKeyFor } from './keys';
import { matchReadback } from './match';
import {
  addMs,
  backoffMs,
  canStoreCaptureId,
  claimsOf,
  foreignCaptureIds,
  insertOperation,
  loadOperationFor,
  loadOrder,
  loadProviderOrders,
  loadUnits,
  unitsOf,
} from './store';
import type { OrderRow, ProviderOrderRow, UnitRow } from './store';
import type { ApplyGates, ApplyReport, ReadinessEvidence } from './types';

type Read = Extract<OrderRead, { kind: 'order' }>;

/**
 * Everything applyReadback needs that is I/O outside the database transaction: the unlock switch
 * and one readiness probe per item. Call it before opening the transaction. A probe that fails is
 * listed in `not_ready`, not thrown.
 */
export async function readApplyGates(d: PaymentsDeps, order_id: Id): Promise<ApplyGates> {
  const unlock_enabled = await d.switches.isOn('unlock_enabled');
  const order = await loadOrder(d.db, order_id);
  if (order === null) throw new Error(`readApplyGates: unknown order ${order_id}`);
  const found = await d.db.query<{ snapshot: unknown }>(
    'SELECT snapshot FROM approvals WHERE id = $1',
    [order.approval_id],
  );
  const raw = found.rows[0]?.snapshot;
  const snapshot = ApprovalSnapshotSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  const readiness: ReadinessEvidence[] = [];
  const not_ready: ApplyGates['not_ready'] = [];
  for (const item of snapshot.items) {
    const r = await checkReadiness(d, {
      article_id: item.article_id,
      expected_sha256: item.article_sha256,
    });
    if (r.ok) {
      readiness.push({
        article_id: item.article_id,
        content_sha256: r.value.content_sha256,
        link_probe: r.value.link_probe,
      });
    } else {
      not_ready.push({ article_id: item.article_id, code: r.error.code });
    }
  }
  return { unlock_enabled, readiness, not_ready };
}

const WRITABLE: ReadonlySet<ProviderOrderState> = new Set([
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'captured',
]);
const IN_FLIGHT: ReadonlySet<ProviderOrderState> = new Set([
  'capture_requested',
  'capture_claimed',
  'unresolved',
]);

type AlertFn = (a: Parameters<typeof raiseAlert>[2]) => Promise<void>;
const suffixed = (po: Pick<ProviderOrderRow, 'route' | 'position'>, base: string): string =>
  po.route === 'single' ? base : `${base}_p${po.position}`;

/**
 * One read of ONE PayPal order, matched against the slice of the expected transaction that belongs to
 * it and applied in the caller's transaction (DP-2a). The PayPal order is `provider_order_ref`, else the
 * one of this order that holds the PayPal id the read carries, else (a single order) its only one. Only
 * that PayPal order's units, operations and state change; orders.status then follows from
 * deriveOrderStatus. A single-route order behaves exactly as before.
 */
export async function applyReadback(
  tx: SqlExecutor,
  d: CoreDeps,
  i: {
    order_id: Id;
    read: Read;
    trigger: 'return' | 'capture' | 'poll' | 'webhook';
    gates?: ApplyGates;
    provider_order_ref?: Id;
  },
): Promise<ApplyReport> {
  // Lock order: the order, its PayPal orders, its operations first (store.ts lockOrderRows).
  const { order, pos } = await lockGraph(tx, i.order_id);
  const po =
    i.provider_order_ref !== undefined
      ? pos.find((p) => p.id === i.provider_order_ref)
      : (pos.find((p) => p.provider_order_id === i.read.provider_order_id) ??
        (pos.length === 1 ? pos[0] : undefined));
  if (po === undefined || po.provider_order_id === null) {
    throw new Error(`applyReadback: order ${order.id} needs the stored provider order of the read`);
  }
  const at = d.clock.now().toISOString();
  const allUnits = await loadUnits(tx, order.id);
  const units = unitsOf(allUnits, po);
  const report: ApplyReport = {
    order_status: order.status,
    unlocked: [],
    pending: [],
    declined: [],
    mismatched: [],
    alerts: [],
  };
  const alert: AlertFn = async (a) => {
    const raised = await raiseAlert(tx, d, a);
    if (raised !== null) report.alerts.push(raised);
  };

  const match = matchReadback({
    expected: expectedFor(
      order.expected,
      units.map((u) => u.reference_id),
    ),
    read: i.read,
    provider_order_id: po.provider_order_id,
    claims: claimsOf(units),
    foreign_capture_ids: await foreignCaptureIds(
      tx,
      order.id,
      i.read.units.map((u) => (u.capture === null ? null : u.capture.capture_id)),
      units.map((u) => u.id),
    ),
  });

  // P7: an order-level failure freezes the PayPal order and changes no unit.
  if (match.level === 'order') {
    report.mismatched = units.map((u) => u.id);
    await freezePo(tx, d, order, po, report, alert, `read_${match.field}`, at, i.trigger);
    await receiptIfMoney(tx, d, order.id);
    return report;
  }

  const bad = match.units.filter((u) => u.result === 'mismatch');
  if (bad.length > 0) {
    // Any unit mismatch: nothing from this read is trusted, so nothing unlocks from it.
    for (const m of bad) {
      const unit = units.find((u) => u.reference_id === m.reference_id);
      if (unit === undefined) continue;
      report.mismatched.push(unit.id);
      if (unit.captured_verified_at === null && unit.status !== 'declined') {
        await tx.query(
          `UPDATE order_units SET status = 'mismatch', mismatch_reason = $2, updated_at = $3
           WHERE id = $1 AND captured_verified_at IS NULL`,
          [unit.id, m.field, at],
        );
      }
      await alert({
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: unit.id,
        reason: `unit_${m.field}`,
        detail: { field: m.field, trigger: i.trigger },
      });
    }
    await freezePo(tx, d, order, po, report, alert, null, at, i.trigger);
    await receiptIfMoney(tx, d, order.id);
    return report;
  }

  if (po.state === 'frozen') {
    // A human decides; a clean read later changes nothing by itself.
    return report;
  }
  if (!WRITABLE.has(po.state)) {
    // Not captured yet (prepared, awaiting the buyer, approved), or given up (failed, declined,
    // abandoned): a capture was not requested, so evidence of one is something a human must look at,
    // never an unlock.
    if (match.units.some((m) => m.result !== 'no_capture')) {
      await alert({
        kind: 'unexpected_capture',
        order_id: order.id,
        unit_id: null,
        reason: `status_${po.route === 'single' ? order.status : po.state}`,
        detail: { trigger: i.trigger },
      });
    }
    return report;
  }

  const byRef = new Map(units.map((u) => [u.reference_id, u]));
  const readByRef = new Map(i.read.units.map((u) => [u.reference_id, u]));
  for (const m of match.units) {
    const unit = byRef.get(m.reference_id);
    const ru = readByRef.get(m.reference_id);
    if (unit === undefined || ru === undefined) continue;
    const cap = ru.capture;

    if (unit.captured_verified_at !== null) {
      // Verified before. A matched read only retries the access start (switch, readiness).
      // A refunded capture never starts a window (lane 05b books the refund).
      if (m.result === 'matched' && cap?.status !== 'REFUNDED') {
        await startAccess(tx, d, unit, i.gates, report, alert, order);
      }
      continue;
    }
    if (unit.status === 'declined' || unit.status === 'mismatch') {
      // A unit we declined (a final DECLINED or FAILED, or a refused capture) whose capture now
      // shows as received is money nobody expects: a human must look; nothing unlocks.
      if (unit.status === 'declined' && m.result === 'matched') {
        await alert({
          kind: 'unexpected_capture',
          order_id: order.id,
          unit_id: unit.id,
          reason: 'declined_unit_received',
          detail: { trigger: i.trigger },
        });
      }
      continue;
    }

    if (m.result === 'pending') {
      report.pending.push(unit.id);
      if (m.field === 'read_before_claim') continue;
      const reason = cap?.status_reason ?? 'PENDING';
      const store = cap !== null && (await canStoreCaptureId(tx, unit.id, cap.capture_id));
      await tx.query(
        `UPDATE order_units SET status = 'pending', status_reason = $2, capture_id = COALESCE($3, capture_id), updated_at = $4
         WHERE id = $1 AND captured_verified_at IS NULL`,
        [unit.id, reason, store && cap !== null ? cap.capture_id : null, at],
      );
    } else if (m.result === 'declined') {
      report.declined.push(unit.id);
      await tx.query(
        `UPDATE order_units SET status = 'declined', status_reason = $2, updated_at = $3
         WHERE id = $1 AND captured_verified_at IS NULL`,
        [unit.id, cap?.status_reason ?? cap?.status ?? 'DECLINED', at],
      );
      await eachEntitlement(tx, unit, async (id) => {
        await applyMoneyEvent(tx, d, { entitlement_id: id, event: 'declined' });
      });
    } else if (m.result === 'matched') {
      // A lost compare-and-set (another caller verified or closed the unit) is a clean no-op:
      // nothing is booked and no access starts from this read.
      if (await verify(tx, d, order, unit, ru, at, alert)) {
        await startAccess(
          tx,
          d,
          { ...unit, captured_verified_at: at },
          i.gates,
          report,
          alert,
          order,
        );
      }
    }
    // no_capture: nothing to record.
  }

  // P8: terminal units, the PayPal order's state, the order status and the operations.
  const fresh = unitsOf(await loadUnits(tx, order.id), po);
  // A unit in mismatch is unverified money a human must look at: the PayPal order is frozen, never
  // failed ("You were not charged" would be false), whatever the read says now (H1).
  const stuck = fresh.find((u) => u.status === 'mismatch' && u.captured_verified_at === null);
  if (stuck !== undefined && po.state !== 'captured') {
    await alert({
      kind: 'frozen_order',
      order_id: order.id,
      unit_id: stuck.id,
      reason: `unit_${stuck.mismatch_reason ?? 'unknown'}`,
      detail: { field: stuck.mismatch_reason, trigger: i.trigger },
    });
    report.mismatched.push(stuck.id);
    await freezePo(tx, d, order, po, report, alert, null, at, i.trigger);
    await receiptIfMoney(tx, d, order.id);
    return report;
  }
  const verified = fresh.filter((u) => u.captured_verified_at !== null).length;
  const terminal = fresh.every(
    (u) => u.captured_verified_at !== null || u.status === 'declined' || u.status === 'mismatch',
  );
  let next: ProviderOrderState = po.state;
  if (terminal) {
    next = verified > 0 ? 'captured' : 'declined';
  } else if (IN_FLIGHT.has(po.state)) {
    next = 'unresolved';
    if (await refusedWithoutCapture(tx, po, i.read)) {
      // PayPal refused the capture for good and the read shows no capture on any unit: nothing
      // was charged. The PayPal order is closed as not charged (M3).
      await declineUnits(tx, d, order.id, 'capture_refused', po);
      next = 'declined';
      report.declined.push(
        ...fresh.filter((u) => u.captured_verified_at === null).map((u) => u.id),
      );
    }
  }
  if (next !== po.state) await setPoState(tx, po.id, next, at, [po.state]);
  report.order_status = (await refreshOrder(tx, d, order.id)).status;
  await settleOperations(tx, d, order, po, next, i.read, at);

  await receiptIfMoney(tx, d, order.id);
  return report;
}

// ---------------------------------------------------------------------------------------------

/** A receipt exists once any unit of the order is verified; a new version only when its body changed. */
async function receiptIfMoney(tx: SqlExecutor, d: CoreDeps, order_id: Id): Promise<void> {
  const any = await tx.query(
    'SELECT 1 FROM order_units WHERE order_id = $1 AND captured_verified_at IS NOT NULL LIMIT 1',
    [order_id],
  );
  if (any.rows.length > 0) await issueReceiptIfChanged(tx, d, { order_id });
}

/** Items of a failed order (or of one PayPal order of it): units declined with a reason, entitlements denied. */
export async function declineUnits(
  tx: SqlExecutor,
  d: CoreDeps,
  order_id: Id,
  reason: string,
  po?: Pick<ProviderOrderRow, 'id' | 'route'>,
): Promise<void> {
  const at = d.clock.now().toISOString();
  const all = await loadUnits(tx, order_id);
  for (const unit of po === undefined ? all : unitsOf(all, po)) {
    await tx.query(
      `UPDATE order_units SET status = 'declined', status_reason = $2, updated_at = $3
       WHERE id = $1 AND captured_verified_at IS NULL`,
      [unit.id, reason, at],
    );
    const ents = await tx.query<{ id: string }>(
      'SELECT id FROM entitlements WHERE unit_id = $1 ORDER BY article_id',
      [unit.id],
    );
    for (const e of ents.rows) {
      await applyMoneyEvent(tx, d, { entitlement_id: e.id, event: 'declined' });
    }
  }
}

// The capture operation was refused for good (a 4xx that is not "not approved") and the read shows
// no capture on any unit.
async function refusedWithoutCapture(
  tx: SqlExecutor,
  po: ProviderOrderRow,
  read: Read,
): Promise<boolean> {
  if (read.units.some((u) => u.capture !== null)) return false;
  const cap = await loadOperationFor(tx, po, 'capture');
  return (
    cap !== null &&
    cap.state === 'failed' &&
    (
      await tx.query(
        "SELECT 1 FROM operations WHERE id = $1 AND failure_reason IN ('rejected', 'invalid_request')",
        [cap.id],
      )
    ).rows.length > 0
  );
}

async function eachEntitlement(
  tx: SqlExecutor,
  unit: UnitRow,
  f: (entitlement_id: Id, article_id: Id) => Promise<void>,
): Promise<void> {
  const found = await tx.query<{ id: string; article_id: string }>(
    'SELECT id, article_id FROM entitlements WHERE unit_id = $1 ORDER BY article_id',
    [unit.id],
  );
  for (const e of found.rows) await f(e.id, e.article_id);
}

// A bad read of one PayPal order. A PayPal order not captured yet freezes for a human; a captured one
// stays captured and is flagged, because money was taken and a later clean read must still be able to
// book a refund. Only this PayPal order is held: the others of the pack keep their state, and the order
// status is derived from all of them.
async function freezePo(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  po: ProviderOrderRow,
  report: ApplyReport,
  alert: AlertFn,
  orderReason: string | null,
  at: string,
  trigger: string,
): Promise<void> {
  if (orderReason !== null) {
    await alert({
      kind: 'frozen_order',
      order_id: order.id,
      unit_id: null,
      reason: suffixed(po, orderReason),
      detail: { trigger },
    });
  }
  const terminal =
    po.state === 'captured' ||
    po.state === 'frozen' ||
    po.state === 'failed' ||
    po.state === 'declined' ||
    po.state === 'abandoned';
  if (terminal) {
    // Already stopped (or paid): the alert above records the new problem and the flag is set.
    await tx.query('UPDATE orders SET mismatch = true, updated_at = $2 WHERE id = $1', [
      order.id,
      at,
    ]);
    report.order_status = order.status;
    return;
  }
  await setPoState(tx, po.id, 'frozen', at, [po.state]);
  // An unknown capture operation ends here: the evidence is wrong, not missing.
  await tx.query(
    `UPDATE operations SET state = 'failed', failure_reason = 'mismatch', lease_until = NULL, next_retry_at = NULL, updated_at = $2
     WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown'
       AND ($3 = 'single' OR provider_order_ref = $4)`,
    [order.id, at, po.route, po.id],
  );
  await tx.query('UPDATE orders SET mismatch = true WHERE id = $1', [order.id]);
  report.order_status = (await refreshOrder(tx, d, order.id)).status;
}

// Compare-and-set: of a webhook and a poller racing, one wins and books.
async function verify(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  unit: UnitRow,
  ru: Read['units'][number],
  at: string,
  alert: (a: Parameters<typeof raiseAlert>[2]) => Promise<void>,
): Promise<boolean> {
  const cap = ru.capture;
  if (cap === null) throw new Error('unreachable: a matched unit has a capture');
  const won = await tx.query(
    `UPDATE order_units SET status = 'captured_verified', capture_id = $2, captured_verified_at = $3,
       paypal_fee_minor = $4, status_reason = NULL, updated_at = $3
     WHERE id = $1 AND captured_verified_at IS NULL AND status IN ('expected', 'pending') RETURNING id`,
    [unit.id, cap.capture_id, at, cap.paypal_fee_minor],
  );
  if (won.rows.length === 0) return false; // someone else verified it first, or the unit is no longer open
  await eachEntitlement(tx, unit, async (id) => {
    const r = await applyMoneyEvent(tx, d, { entitlement_id: id, event: 'capture_verified' });
    if (!r.ok) throw new Error(`entitlement ${id}: ${r.error.code} on a verified capture`);
  });
  // Book what PayPal captured (matchReadback has checked it equals the unit amount).
  const money = { currency: cap.amount.currency, minor: cap.amount.minor };
  const sale = await appendLedgerEntry(tx, d, {
    unit_id: unit.id,
    capture_id: cap.capture_id,
    kind: 'sale',
    amount: money,
    refund_id: null,
    ref_entry_id: null,
  });
  const sale_id = sale.ok ? sale.value.id : sale.error.existing_entry_id;
  if (cap.paypal_fee_minor !== null) {
    await appendLedgerEntry(tx, d, {
      unit_id: unit.id,
      capture_id: cap.capture_id,
      kind: 'paypal_fee',
      amount: { currency: order.currency, minor: cap.paypal_fee_minor },
      refund_id: null,
      ref_entry_id: sale_id,
    });
    if (cap.paypal_fee_minor > unit.amount_minor) {
      await alert({
        kind: 'fee_above_amount',
        order_id: order.id,
        unit_id: unit.id,
        reason: 'fee_above_amount',
        detail: { fee_minor: cap.paypal_fee_minor, amount_minor: unit.amount_minor },
      });
    }
  }
  return true;
}

// The access window starts only when the unlock switch is on and the delivery probe passed. Without
// gates nothing starts. markAccessReady never restarts a window, so calling it again is safe.
async function startAccess(
  tx: SqlExecutor,
  d: CoreDeps,
  unit: UnitRow,
  gates: ApplyGates | undefined,
  report: ApplyReport,
  alert: (a: Parameters<typeof raiseAlert>[2]) => Promise<void>,
  order: OrderRow,
): Promise<void> {
  if (gates === undefined || !gates.unlock_enabled) return;
  const capture_id = (
    await tx.query<{ capture_id: string | null }>(
      'SELECT capture_id FROM order_units WHERE id = $1',
      [unit.id],
    )
  ).rows[0]?.capture_id;
  if (capture_id === null || capture_id === undefined) return;
  await eachEntitlement(tx, unit, async (entitlement_id, article_id) => {
    const state = await tx.query<{ state: string }>(
      'SELECT state FROM access_windows WHERE entitlement_id = $1',
      [entitlement_id],
    );
    if (state.rows[0]?.state !== 'not_started') return;
    const evidence = gates.readiness.find((r) => r.article_id === article_id);
    if (evidence === undefined) {
      const why = gates.not_ready.find((n) => n.article_id === article_id);
      await alert({
        kind: 'content_unavailable',
        order_id: order.id,
        unit_id: unit.id,
        reason: `delivery_not_ready_${article_id}`,
        detail: { article_id, code: why?.code ?? 'no_probe' },
      });
      return;
    }
    await markAccessReady(tx, d, {
      entitlement_id,
      evidence: {
        capture_id,
        content_sha256: evidence.content_sha256,
        link_probe: evidence.link_probe,
      },
    });
    report.unlocked.push(entitlement_id);
  });
}

// Operations after a read of one PayPal order: a capture whose answer was lost is settled by a read
// that shows a capture; an unresolved PayPal order keeps one read-back operation for the reconciler
// (lane 05b).
async function settleOperations(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  po: ProviderOrderRow,
  state: ProviderOrderState,
  read: Read,
  at: string,
): Promise<void> {
  const seen = read.units.some((u) => u.capture !== null);
  if (seen) {
    await tx.query(
      `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE order_id = $1 AND kind = 'capture' AND state = 'unknown' AND ($3 = 'single' OR provider_order_ref = $4)`,
      [order.id, at, po.route, po.id],
    );
  }
  if (state === 'unresolved') {
    await ensureReadbackOp(tx, d, order, at, po);
  } else {
    const existing = await loadOperationFor(tx, po, 'readback', { lock: true });
    if (existing !== null && existing.state !== 'confirmed' && existing.state !== 'failed') {
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [existing.id, at],
      );
    }
  }
}

/**
 * A PayPal order whose evidence is missing keeps exactly one read-back operation in state unknown, so
 * the reconciler (lane 05b) polls it with backoff until reconcile_until. `po` is the PayPal order; when
 * omitted it is the first one of the order (the only one for a single order).
 */
export async function ensureReadbackOp(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  at: string,
  po?: ProviderOrderRow,
): Promise<void> {
  const target = po ?? (await loadProviderOrders(tx, order.id))[0];
  if (target === undefined)
    throw new Error(`ensureReadbackOp: order ${order.id} has no provider order`);
  const existing = await loadOperationFor(tx, target, 'readback', { lock: true });
  const cap = await loadOperationFor(tx, target, 'capture');
  const until = addMs(cap?.first_sent_at ?? at, d.config.reconcile_window_ms);
  if (existing === null) {
    await insertOperation(tx, {
      id: d.ids.next('opr'),
      order_id: order.id,
      kind: 'readback',
      state: 'unknown',
      request_id: readbackKeyFor(target.po_ref),
      lease_until: null,
      reconcile_until: until,
      next_retry_at: addMs(at, backoffMs(d.config, 1)),
      at,
      provider_order_ref: target.id,
    });
  } else if (existing.state !== 'unknown') {
    await tx.query(
      `UPDATE operations SET state = 'unknown', failure_reason = NULL, reconcile_until = $2, next_retry_at = $3, lease_until = NULL, updated_at = $4 WHERE id = $1`,
      [existing.id, until, addMs(at, backoffMs(d.config, 1)), at],
    );
  }
}
