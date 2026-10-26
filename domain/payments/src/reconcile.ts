// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/reconcile.ts (P6 to P8: read first,
// retry the capture once with the same key after a read shows no capture) and place.ts (sendCreate
// resend) at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
// The reconciler: one read of the PayPal order, applied by lane 05a's applyReadback in one
// transaction (the gates are read before it opens), plus the two re-sends that are allowed, each
// with its original key: a create and a capture, both only inside the 5 h window and, for a
// capture, only after a read showed no capture. Provider calls never happen inside a transaction.
import {
  CaptureResSchema,
  CreateOrderReqSchema,
  CreateOrderResSchema,
  isUrlUnderOrigin,
} from '@umsbx/contracts';
import type {
  CaptureRes,
  CoreDeps,
  CreateOrderRes,
  Id,
  OrderRead,
  OrderStatus,
  PaymentsDeps,
  SqlExecutor,
} from '@umsbx/contracts';
import { applyReadback, ensureReadbackOp, readApplyGates, declineUnits } from './apply';
import { reasonFor } from './capture';
import {
  endWholeOrder,
  isSent,
  lockGraph,
  poFacts,
  poIn,
  refreshOrder,
  setPoState,
} from './composite';
import { raiseOpsAlert, observeReadback } from './refunds';
import { addMs, loadOrder, loadProviderOrders, loadUnits, unitsOf } from './store';
import type { OperationRow, OrderRow, ProviderOrderRow } from './store';
import type { ApplyGates, ApplyReport } from './types';

type Read = Extract<OrderRead, { kind: 'order' }>;

/** Orders the reconciler leaves alone: finished without money, or waiting for a human. */
export const TERMINAL: ReadonlySet<OrderStatus> = new Set(['failed', 'abandoned', 'frozen']);

export type ReadOutcome =
  | { kind: 'applied'; report: ApplyReport; read: Read; reads: PoRead[] }
  | { kind: 'paused' }
  | { kind: 'failed' };
/** One PayPal order's read and what applying it reported. */
export interface PoRead {
  po: ProviderOrderRow;
  read: Read;
  report: ApplyReport;
}

/**
 * One read of ONE PayPal order, applied to its own slice in one transaction (DP-2b). The gates (the
 * unlock switch and the delivery probe) are read before the transaction; pass them in to reuse them.
 */
export async function applyOneRead(
  d: PaymentsDeps,
  order: OrderRow,
  po: Pick<ProviderOrderRow, 'id'>,
  read: Read,
  trigger: 'return' | 'capture' | 'poll' | 'webhook',
  gates?: ApplyGates,
): Promise<ApplyReport> {
  const g = gates ?? (await readApplyGates(d, order.id));
  return d.db.transaction(async (tx) => {
    const applied = await applyReadback(tx, d, {
      order_id: order.id,
      read,
      trigger,
      gates: g,
      provider_order_ref: po.id,
    });
    await observeReadback(tx, d, read);
    return applied;
  });
}

const mergeReports = (reports: ApplyReport[]): ApplyReport => {
  const last = reports[reports.length - 1] as ApplyReport;
  return {
    order_status: last.order_status,
    unlocked: reports.flatMap((r) => r.unlocked),
    pending: reports.flatMap((r) => r.pending),
    declined: reports.flatMap((r) => r.declined),
    mismatched: reports.flatMap((r) => r.mismatched),
    alerts: reports.flatMap((r) => r.alerts),
  };
};

/**
 * Reads the PayPal orders of the order at PayPal (each by its stored provider order id only), then
 * applies each read to its own slice, one transaction per PayPal order. `only` limits the reading to
 * those PayPal orders (the one whose operation is due). The switch is read before; the delivery probe
 * is read once and reused. A read that is blocked pauses the pass; a read that proves nothing (no
 * answer) is skipped; with nothing usable the outcome is `failed`.
 */
export async function readAndApply(
  d: PaymentsDeps,
  order: OrderRow,
  trigger: 'poll' | 'webhook',
  only?: readonly Id[],
): Promise<ReadOutcome> {
  if (!(await d.switches.isOn('paypal_outbound'))) return { kind: 'paused' };
  const targets = (await loadProviderOrders(d.db, order.id)).filter(
    (p) => p.provider_order_id !== null && (only === undefined || only.includes(p.id)),
  );
  const done: PoRead[] = [];
  let gates: ApplyGates | undefined;
  for (const po of targets) {
    const read = await d.paypal.getOrder(po.provider_order_id as string);
    if (read.kind === 'blocked') return { kind: 'paused' };
    if (read.kind !== 'order') continue;
    gates ??= await readApplyGates(d, order.id);
    done.push({ po, read, report: await applyOneRead(d, order, po, read, trigger, gates) });
  }
  const first = done[0];
  if (first === undefined) return { kind: 'failed' };
  return {
    kind: 'applied',
    report: mergeReports(done.map((r) => r.report)),
    read: first.read,
    reads: done,
  };
}

export async function reconcileOrder(
  d: PaymentsDeps,
  i: { order_id: Id; trigger: 'poll' | 'webhook' | 'manual' },
): Promise<ApplyReport | { skipped: 'terminal' | 'paused' }> {
  const order = await loadOrder(d.db, i.order_id);
  if (order === null) throw new Error(`reconcileOrder: unknown order ${i.order_id}`);
  if (TERMINAL.has(order.status)) return { skipped: 'terminal' };
  const r = await readAndApply(d, order, i.trigger === 'webhook' ? 'webhook' : 'poll');
  if (r.kind === 'paused') return { skipped: 'paused' };
  if (r.kind === 'failed') {
    // Nothing usable was read (no provider order yet, or PayPal did not answer): nothing changes.
    const now = (await loadOrder(d.db, order.id)) ?? order;
    return {
      order_status: now.status,
      unlocked: [],
      pending: [],
      declined: [],
      mismatched: [],
      alerts: [],
    };
  }
  return r.report;
}

// ---------------------------------------------------------------------------------------------

/** The PayPal order an operation belongs to: its own reference, else the one that holds the PayPal id, else the only one. */
function poOfOperation(
  pos: readonly ProviderOrderRow[],
  op: Pick<OperationRow, 'provider_order_ref'>,
  provider_order_id: string | null,
  given?: ProviderOrderRow,
): ProviderOrderRow {
  const found =
    given !== undefined
      ? pos.find((p) => p.id === given.id)
      : ((op.provider_order_ref === undefined || op.provider_order_ref === null
          ? undefined
          : pos.find((p) => p.id === op.provider_order_ref)) ??
        (provider_order_id === null
          ? undefined
          : pos.find((p) => p.provider_order_id === provider_order_id)) ??
        (pos.length === 1 ? pos[0] : undefined));
  if (found === undefined) throw new Error('operation belongs to no provider order of its order');
  return found;
}

/** Items of the moved PayPal orders of a whole-order outcome: units declined, entitlements denied. */
export async function declineMoved(
  tx: SqlExecutor,
  d: CoreDeps,
  order_id: Id,
  moved: readonly Id[],
  pos: readonly ProviderOrderRow[],
  reason: string,
): Promise<void> {
  for (const id of moved) {
    const po = pos.find((p) => p.id === id);
    if (po !== undefined) await declineUnits(tx, d, order_id, reason, po);
  }
}

/**
 * The one capture re-send, for ONE PayPal order. Claimed by compare-and-set on the attempt number (of
 * two callers one wins), sent with the original key outside any transaction, recorded afterwards. The
 * answer is only a claim: 'claim' tells the caller to read the order again at once. It changes the
 * state of that PayPal order only; the order status follows from deriveOrderStatus.
 */
export async function retryCapture(
  d: PaymentsDeps,
  order: OrderRow,
  op: OperationRow,
  provider_order_id: string,
  po?: ProviderOrderRow,
): Promise<'claim' | 'unknown' | 'reopened' | 'frozen' | 'lost'> {
  const target = await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    // Lock order: the order, its PayPal orders, its operations first (store.ts lockOrderRows).
    const graph = await lockGraph(tx, order.id);
    const mine = poOfOperation(graph.pos, op, provider_order_id, po);
    // Only a PayPal order whose capture is in flight is sent again: never a declined, frozen,
    // captured or still-waiting one (the capture of a PayPal order that is over is never repeated).
    if (!['capture_requested', 'capture_claimed', 'unresolved'].includes(mine.state)) return null;
    const won = await tx.query(
      `UPDATE operations SET state = 'sent', attempt = attempt + 1, lease_until = $2, next_retry_at = NULL, updated_at = $3
       WHERE id = $1 AND state = 'unknown' AND attempt = $4 RETURNING id`,
      [op.id, addMs(at, d.config.operation_lease_ms), at, op.attempt],
    );
    if (won.rows.length === 0) return null;
    await setPoState(tx, mine.id, 'capture_requested', at, ['unresolved']);
    await refreshOrder(tx, d, order.id);
    return mine;
  });
  if (target === null) return 'lost';

  // Outside any transaction (P14). The process may die here: the operation stays `sent`.
  const raw = await d.paypal.captureOrder({
    provider_order_id,
    request_id: op.request_id,
    scenario: null,
  });
  const parsed = CaptureResSchema.safeParse(raw);
  const res: CaptureRes = parsed.success ? parsed.data : { kind: 'timeout' };

  return d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    // Lock order, then operation. The PayPal order may have moved on while the call was open (frozen
    // by a concurrent read, verified by a poll): then only the operation is closed to match, and the
    // PayPal order is never moved backwards (H1, M2).
    const graph = await lockGraph(tx, order.id);
    const current = graph.order;
    const po = poIn(graph, target.id);
    const live = po.state === 'capture_requested';
    const money = po.state === 'captured';
    const settleDead = async (): Promise<void> => {
      const set = money
        ? "state = 'confirmed', lease_until = NULL, next_retry_at = NULL"
        : po.state === 'frozen'
          ? "state = 'failed', failure_reason = 'mismatch', lease_until = NULL, next_retry_at = NULL"
          : null;
      if (set !== null) {
        await tx.query(
          `UPDATE operations SET ${set}, updated_at = $2 WHERE id = $1 AND state IN ('sent', 'unknown')`,
          [op.id, at],
        );
      }
    };
    const unknown = async (): Promise<void> => {
      if (!live) return settleDead();
      await tx.query(
        `UPDATE operations SET state = 'unknown', lease_until = NULL, next_retry_at = $2, updated_at = $2
         WHERE id = $1 AND state IN ('sent', 'unknown')`,
        [op.id, at],
      );
      await setPoState(tx, po.id, 'unresolved', at, ['capture_requested']);
      await refreshOrder(tx, d, order.id);
    };
    // The read-back operation of a PayPal order that goes back to the buyer or stops has nothing to poll.
    const closeReadback = async (state: 'confirmed' | 'failed'): Promise<void> => {
      await tx.query(
        `UPDATE operations SET state = $3, failure_reason = $4, lease_until = NULL, next_retry_at = NULL, updated_at = $5
         WHERE order_id = $6 AND kind = 'readback' AND state = 'unknown'
           AND (provider_order_ref = $1 OR (provider_order_ref IS NULL AND $2 = 'single'))`,
        [po.id, po.route, state, state === 'failed' ? 'mismatch' : null, at, order.id],
      );
    };
    const reopen = async (): Promise<boolean> => {
      if (!live) {
        await settleDead();
        return false;
      }
      await closeReadback('confirmed');
      // Nothing was captured; the buyer has to act at PayPal. The attempt count is kept, so the
      // next try (a new key, see capture.ts gate) is counted against the cap.
      await tx.query(
        `UPDATE operations SET state = 'prepared', lease_until = $2, updated_at = $2 WHERE id = $1 AND state IN ('sent', 'unknown')`,
        [op.id, at],
      );
      await setPoState(tx, po.id, 'approved', at, ['capture_requested']);
      await refreshOrder(tx, d, order.id);
      return true;
    };
    if (res.kind === 'payer_action') {
      if (!(await reopen())) return 'lost' as const;
      if (res.redirect_url !== null) {
        // This PayPal order's approve url only: the buyer approves this one again.
        await tx.query(
          'UPDATE provider_orders SET approve_url = $2, updated_at = $3 WHERE id = $1',
          [po.id, res.redirect_url, at],
        );
      }
      return 'reopened' as const;
    }
    if (res.kind === 'rejected' && res.issue === 'ORDER_NOT_APPROVED') {
      return (await reopen()) ? ('reopened' as const) : ('lost' as const);
    }
    if (res.kind === 'rejected' && res.issue === 'DUPLICATE_INVOICE_ID') {
      // A late answer for a PayPal order that has moved on changes nothing (like every answer path).
      if (!live) {
        await settleDead();
        return 'lost' as const;
      }
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      // Before any capture the whole order is frozen; once another PayPal order of the pack was sent,
      // only this one is held (a frozen PayPal order is on hold, never "not charged").
      const others = (await poFacts(tx, order.id)).some((f) => f.id !== po.id && isSent(f));
      if (others) {
        await setPoState(tx, po.id, 'frozen', at, ['capture_requested']);
        await refreshOrder(tx, d, order.id);
      } else {
        await endWholeOrder(tx, d, order.id, 'frozen');
      }
      await closeReadback('failed');
      await raiseOpsAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: null,
        reason: reasonFor(po, 'duplicate_invoice_id'),
        detail: { debug_id: res.debug_id },
      });
      return 'frozen' as const;
    }
    if (res.kind === 'rejected' && res.issue !== 'ORDER_ALREADY_CAPTURED') {
      // The same rule as the first send (capture.ts): a refusal closes the capture operation as
      // failed; the PayPal order stays unresolved and the read-back operation decides (nothing is
      // recharged, nothing is declared failed without a read that shows no capture).
      if (!live) {
        await settleDead();
        return 'unknown' as const;
      }
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3
         WHERE id = $1 AND state IN ('sent', 'unknown')`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await setPoState(tx, po.id, 'unresolved', at, ['capture_requested']);
      await refreshOrder(tx, d, order.id);
      if (res.http === 400) {
        await raiseOpsAlert(tx, d, {
          kind: 'payment_unresolved',
          order_id: order.id,
          unit_id: null,
          reason: reasonFor(po, 'capture_invalid_request'),
          detail: { debug_id: res.debug_id },
        });
      }
      await ensureReadbackOp(tx, d, current, at, po);
      return 'unknown' as const;
    }
    await unknown();
    if (res.kind === 'blocked' && live) {
      // Nothing was sent: the attempt is not spent.
      await tx.query('UPDATE operations SET attempt = $2 WHERE id = $1', [op.id, op.attempt]);
    }
    return res.kind === 'claim' ? ('claim' as const) : ('unknown' as const);
  });
}

/**
 * The create re-send of ONE PayPal order, inside the 5 h window only (the caller checks). It rebuilds
 * that PayPal order's create alone: its own unit, its own invoice id (po_ref) and its own key, so a
 * pack never gets a two-unit order. Same key as the first send, so PayPal answers with the order it
 * already made. Never charges anything. Recorded like beginCheckout records the first answer, on that
 * PayPal order only (WHERE id).
 */
export async function resendCreate(
  d: PaymentsDeps,
  order: OrderRow,
  op: OperationRow,
): Promise<'confirmed' | 'failed' | 'unknown' | 'lost'> {
  const prepared = await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const graph = await lockGraph(tx, order.id);
    const po = poOfOperation(graph.pos, op, null);
    // The checkout moved on without this operation hearing of it: nothing to create.
    if (po.state !== 'prepared') return null;
    const units = unitsOf(await loadUnits(tx, order.id), po);
    const origin = d.config.public_origin;
    const ref = encodeURIComponent(order.order_ref);
    const return_url = `${origin}/checkout/return?ref=${ref}`;
    const cancel_url = `${origin}/checkout/cancel?ref=${ref}`;
    if (!isUrlUnderOrigin(return_url, origin) || !isUrlUnderOrigin(cancel_url, origin)) {
      throw new Error('return and cancel URLs must sit under the configured public origin');
    }
    const req = CreateOrderReqSchema.parse({
      request_id: op.request_id,
      order_ref: order.order_ref,
      units: units.map((u) => ({
        reference_id: u.reference_id,
        payee_merchant_id: u.payee_merchant_id,
        amount: { currency: order.currency, minor: u.amount_minor },
      })),
      return_url,
      cancel_url,
      scenario: null,
      // A pack: the invoice id of the PayPal order is its po_ref (a single order sends none).
      ...(po.route === 'single' ? {} : { invoice_id: po.po_ref }),
    });
    const won = await tx.query(
      `UPDATE operations SET state = 'sent', attempt = attempt + 1, first_sent_at = COALESCE(first_sent_at, $2),
         idem_safe_until = COALESCE(idem_safe_until, $3), lease_until = $4, next_retry_at = NULL, updated_at = $2
       WHERE id = $1 AND state = 'unknown' AND attempt = $5 RETURNING id`,
      [
        op.id,
        at,
        addMs(at, d.config.idem_safe_window_ms),
        addMs(at, d.config.operation_lease_ms),
        op.attempt,
      ],
    );
    return won.rows.length === 0 ? null : { req, po };
  });
  if (prepared === null) return 'lost';

  // Outside any transaction (P14).
  const raw = await d.paypal.createOrder(prepared.req);
  const parsed = CreateOrderResSchema.safeParse(raw);
  const res: CreateOrderRes = parsed.success ? parsed.data : { kind: 'timeout' };

  return d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const graph = await lockGraph(tx, order.id);
    const live = poIn(graph, prepared.po.id).state === 'prepared';
    const unknown = async (): Promise<'unknown'> => {
      await tx.query(
        `UPDATE operations SET state = 'unknown', lease_until = NULL, next_retry_at = $2, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      return 'unknown';
    };
    if (res.kind === 'created') {
      // The PayPal order exists: its id is kept even if the checkout moved on meanwhile, so it can be read.
      await tx.query(
        `UPDATE provider_orders SET provider_order_id = $2, approve_url = $3, status = $4, updated_at = $5
          WHERE id = $1 AND provider_order_id IS NULL`,
        [prepared.po.id, res.provider_order_id, res.approve_url, res.status, at],
      );
      if (live) await setPoState(tx, prepared.po.id, 'awaiting_buyer', at, ['prepared']);
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      await refreshOrder(tx, d, order.id);
      return 'confirmed' as const;
    }
    if (res.kind === 'rejected' && res.issue === 'DUPLICATE_INVOICE_ID') {
      // A suspected duplicate: frozen for a human, nothing declined (same as beginCheckout).
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = 'rejected', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      if (!live) return 'failed' as const;
      await endWholeOrder(tx, d, order.id, 'frozen');
      await raiseOpsAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: null,
        reason: 'duplicate_invoice_id',
        detail: { phase: 'create', debug_id: res.debug_id },
      });
      return 'failed' as const;
    }
    if (res.kind === 'rejected') {
      // Nothing was charged: the order never existed at PayPal.
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      if (!live) return 'failed' as const;
      // The whole order fails: no PayPal order of it is kept beside a refused one.
      const moved = await endWholeOrder(tx, d, order.id, 'failed');
      await declineMoved(tx, d, order.id, moved, graph.pos, 'create_rejected');
      await raiseOpsAlert(tx, d, {
        kind: 'create_rejected',
        order_id: order.id,
        unit_id: null,
        reason: `${res.http}_${res.issue ?? res.name}`,
        detail: { http: res.http, name: res.name, debug_id: res.debug_id },
      });
      return 'failed' as const;
    }
    return unknown();
  });
}
