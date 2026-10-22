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
import type {
  CoreDeps,
  Id,
  OrderRead,
  OrderStatus,
  PaymentsDeps,
  SqlExecutor,
} from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import type { AlertKind } from './alerts';
import { readbackKeyFor } from './keys';
import { matchReadback } from './match';
import {
  addMs,
  backoffMs,
  canStoreCaptureId,
  claimsOf,
  foreignCaptureIds,
  insertOperation,
  loadOperation,
  loadOrder,
  loadProviderOrders,
  loadUnits,
} from './store';
import type { OrderRow, UnitRow } from './store';
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

const WRITABLE: ReadonlySet<OrderStatus> = new Set([
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'paid',
  'paid_partial',
]);
const IN_FLIGHT: ReadonlySet<OrderStatus> = new Set([
  'capture_requested',
  'capture_claimed',
  'unresolved',
]);

export async function applyReadback(
  tx: SqlExecutor,
  d: CoreDeps,
  i: {
    order_id: Id;
    read: Read;
    trigger: 'return' | 'capture' | 'poll' | 'webhook';
    gates?: ApplyGates;
  },
): Promise<ApplyReport> {
  const order = await loadOrder(tx, i.order_id, { lock: true });
  if (order === null) throw new Error(`applyReadback: unknown order ${i.order_id}`);
  const providers = await loadProviderOrders(tx, order.id);
  const provider = providers[0];
  if (providers.length !== 1 || provider === undefined || provider.provider_order_id === null) {
    // The per-publisher route (several PayPal orders per order) is MVP-D.
    throw new Error(`applyReadback: order ${order.id} needs exactly one stored provider order`);
  }
  const at = d.clock.now().toISOString();
  const units = await loadUnits(tx, order.id);
  const report: ApplyReport = {
    order_status: order.status,
    unlocked: [],
    pending: [],
    declined: [],
    mismatched: [],
    alerts: [],
  };
  const alert = async (a: Parameters<typeof raiseAlert>[2]): Promise<void> => {
    const raised = await raiseAlert(tx, d, a);
    if (raised !== null) report.alerts.push(raised);
  };

  const match = matchReadback({
    expected: order.expected,
    read: i.read,
    provider_order_id: provider.provider_order_id,
    claims: claimsOf(units),
    foreign_capture_ids: await foreignCaptureIds(
      tx,
      order.id,
      i.read.units.map((u) => (u.capture === null ? null : u.capture.capture_id)),
    ),
  });

  // P7: an order-level failure freezes the order and changes no unit.
  if (match.level === 'order') {
    report.mismatched = units.map((u) => u.id);
    await freezeOrMark(tx, order, report, alert, `read_${match.field}`, at, i.trigger);
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
    await freezeOrMark(tx, order, report, alert, null, at, i.trigger);
    return report;
  }

  if (order.status === 'frozen') {
    // A human decides; a clean read later changes nothing by itself.
    return report;
  }
  if (!WRITABLE.has(order.status)) {
    // created, awaiting_buyer, failed, abandoned: a capture was not requested (or was given up),
    // so evidence of one is something a human must look at, never an unlock.
    if (match.units.some((m) => m.result !== 'no_capture')) {
      await alert({
        kind: 'unexpected_capture',
        order_id: order.id,
        unit_id: null,
        reason: `status_${order.status}`,
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
    if (unit.status === 'declined' || unit.status === 'mismatch') continue;

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
      await verify(tx, d, order, unit, ru, at, alert);
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
    // no_capture: nothing to record.
  }

  // P8: terminal units, the order status and the operations.
  const fresh = await loadUnits(tx, order.id);
  const verified = fresh.filter((u) => u.captured_verified_at !== null).length;
  const terminal = fresh.every(
    (u) => u.captured_verified_at !== null || u.status === 'declined' || u.status === 'mismatch',
  );
  let status: OrderStatus = order.status;
  if (terminal) {
    status = verified === fresh.length ? 'paid' : verified > 0 ? 'paid_partial' : 'failed';
    if (order.status === 'paid_partial' && status === 'paid') status = 'paid';
  } else if (IN_FLIGHT.has(order.status)) {
    status = 'unresolved';
  }
  if (status !== order.status) {
    await tx.query('UPDATE orders SET status = $2, updated_at = $3 WHERE id = $1', [
      order.id,
      status,
      at,
    ]);
  }
  report.order_status = status;
  await settleOperations(tx, d, order, status, i.read, at);

  if (verified > 0) await issueReceiptIfChanged(tx, d, { order_id: order.id });
  return report;
}

// ---------------------------------------------------------------------------------------------

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

// A bad read. An unpaid order freezes for a human; a paid one stays paid and is flagged, because
// money was taken and a later clean read must still be able to book a refund.
async function freezeOrMark(
  tx: SqlExecutor,
  order: OrderRow,
  report: ApplyReport,
  alert: (a: {
    kind: AlertKind;
    order_id: Id;
    unit_id: Id | null;
    reason: string;
    detail?: Record<string, string | number | boolean | null>;
  }) => Promise<void>,
  orderReason: string | null,
  at: string,
  trigger: string,
): Promise<void> {
  const kept = order.status === 'paid' || order.status === 'paid_partial';
  if (orderReason !== null) {
    await alert({
      kind: 'frozen_order',
      order_id: order.id,
      unit_id: null,
      reason: orderReason,
      detail: { trigger },
    });
  }
  if (kept) {
    await tx.query('UPDATE orders SET mismatch = true, updated_at = $2 WHERE id = $1', [
      order.id,
      at,
    ]);
    report.order_status = order.status;
    return;
  }
  if (order.status === 'frozen' || order.status === 'failed' || order.status === 'abandoned') {
    // Already stopped; the alert above records the new problem.
    await tx.query('UPDATE orders SET mismatch = true, updated_at = $2 WHERE id = $1', [
      order.id,
      at,
    ]);
    report.order_status = order.status;
    return;
  }
  await tx.query(
    "UPDATE orders SET status = 'frozen', mismatch = true, updated_at = $2 WHERE id = $1",
    [order.id, at],
  );
  // An unknown capture operation ends here: the evidence is wrong, not missing.
  await tx.query(
    `UPDATE operations SET state = 'failed', failure_reason = 'mismatch', lease_until = NULL, next_retry_at = NULL, updated_at = $2
     WHERE order_id = $1 AND kind IN ('capture', 'readback') AND state = 'unknown'`,
    [order.id, at],
  );
  report.order_status = 'frozen';
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
): Promise<void> {
  const cap = ru.capture;
  if (cap === null) throw new Error('unreachable: a matched unit has a capture');
  const won = await tx.query(
    `UPDATE order_units SET status = 'captured_verified', capture_id = $2, captured_verified_at = $3,
       paypal_fee_minor = $4, status_reason = NULL, updated_at = $3
     WHERE id = $1 AND captured_verified_at IS NULL AND status IN ('expected', 'pending') RETURNING id`,
    [unit.id, cap.capture_id, at, cap.paypal_fee_minor],
  );
  if (won.rows.length === 0) return; // someone else verified it first, or the unit is no longer open
  await eachEntitlement(tx, unit, async (id) => {
    const r = await applyMoneyEvent(tx, d, { entitlement_id: id, event: 'capture_verified' });
    if (!r.ok) throw new Error(`entitlement ${id}: ${r.error.code} on a verified capture`);
  });
  const money = { currency: order.currency, minor: unit.amount_minor };
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

// Operations after a read: a capture whose answer was lost is settled by a read that shows a
// capture; an unresolved order keeps one read-back operation for the reconciler (lane 05b).
async function settleOperations(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  status: OrderStatus,
  read: Read,
  at: string,
): Promise<void> {
  const seen = read.units.some((u) => u.capture !== null);
  if (seen) {
    await tx.query(
      `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2
       WHERE order_id = $1 AND kind = 'capture' AND state = 'unknown'`,
      [order.id, at],
    );
  }
  if (status === 'unresolved') {
    await ensureReadbackOp(tx, d, order, at);
  } else {
    const existing = await loadOperation(tx, order.id, 'readback', { lock: true });
    if (existing !== null && existing.state !== 'confirmed' && existing.state !== 'failed') {
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [existing.id, at],
      );
    }
  }
}

/**
 * An order whose evidence is missing keeps exactly one read-back operation in state unknown, so
 * the reconciler (lane 05b) polls it with backoff until reconcile_until.
 */
export async function ensureReadbackOp(
  tx: SqlExecutor,
  d: CoreDeps,
  order: OrderRow,
  at: string,
): Promise<void> {
  const existing = await loadOperation(tx, order.id, 'readback', { lock: true });
  const cap = await loadOperation(tx, order.id, 'capture');
  const until = addMs(cap?.first_sent_at ?? at, d.config.reconcile_window_ms);
  if (existing === null) {
    await insertOperation(tx, {
      id: d.ids.next('opr'),
      order_id: order.id,
      kind: 'readback',
      state: 'unknown',
      request_id: readbackKeyFor(order.order_ref),
      lease_until: null,
      reconcile_until: until,
      next_retry_at: addMs(at, backoffMs(d.config, 1)),
      at,
    });
  } else if (existing.state !== 'unknown') {
    await tx.query(
      `UPDATE operations SET state = 'unknown', failure_reason = NULL, reconcile_until = $2, next_retry_at = $3, lease_until = NULL, updated_at = $4 WHERE id = $1`,
      [existing.id, until, addMs(at, backoffMs(d.config, 1)), at],
    );
  }
}
