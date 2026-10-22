// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/reconcile.ts (P6 to P8: read first,
// retry the capture once with the same key after a read shows no capture) and place.ts (sendCreate
// resend) at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05b.
// The reconciler: one read of the PayPal order, applied by lane 05a's applyReadback in one
// transaction (the gates are read before it opens), plus the two re-sends that are allowed, each
// with its original key: a create and a capture, both only inside the 5 h window and, for a
// capture, only after a read showed no capture. Provider calls never happen inside a transaction.
import { applyMoneyEvent } from '@umsbx/entitlements';
import {
  CaptureResSchema,
  CreateOrderReqSchema,
  CreateOrderResSchema,
  isUrlUnderOrigin,
} from '@umsbx/contracts';
import type {
  CaptureRes,
  CreateOrderRes,
  Id,
  OrderRead,
  OrderStatus,
  PaymentsDeps,
  SqlExecutor,
} from '@umsbx/contracts';
import { applyReadback, readApplyGates } from './apply';
import { raiseOpsAlert, observeReadback } from './refunds';
import { addMs, loadOrder, loadProviderOrders, loadUnits } from './store';
import type { OperationRow, OrderRow } from './store';
import type { ApplyReport } from './types';

type Read = Extract<OrderRead, { kind: 'order' }>;

/** Orders the reconciler leaves alone: finished without money, or waiting for a human. */
export const TERMINAL: ReadonlySet<OrderStatus> = new Set(['failed', 'abandoned', 'frozen']);

export type ReadOutcome =
  { kind: 'applied'; report: ApplyReport; read: Read } | { kind: 'paused' } | { kind: 'failed' };

/**
 * Reads the order at PayPal (stored provider order id only), then applies the read. The switch and
 * the delivery probe are read before the transaction; the read is applied in one transaction.
 */
export async function readAndApply(
  d: PaymentsDeps,
  order: OrderRow,
  trigger: 'poll' | 'webhook',
): Promise<ReadOutcome> {
  if (!(await d.switches.isOn('paypal_outbound'))) return { kind: 'paused' };
  const provider = (await loadProviderOrders(d.db, order.id))[0];
  if (provider === undefined || provider.provider_order_id === null) return { kind: 'failed' };
  const read = await d.paypal.getOrder(provider.provider_order_id);
  if (read.kind === 'blocked') return { kind: 'paused' };
  if (read.kind !== 'order') return { kind: 'failed' };
  const gates = await readApplyGates(d, order.id);
  const report = await d.db.transaction(async (tx) => {
    const applied = await applyReadback(tx, d, { order_id: order.id, read, trigger, gates });
    await observeReadback(tx, d, read);
    return applied;
  });
  return { kind: 'applied', report, read };
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

/** Items of a failed order: units declined with a reason, entitlements denied. */
export async function declineUnits(
  tx: SqlExecutor,
  d: PaymentsDeps,
  order_id: Id,
  reason: string,
): Promise<void> {
  const at = d.clock.now().toISOString();
  for (const unit of await loadUnits(tx, order_id)) {
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

/**
 * The one capture re-send. Claimed by compare-and-set on the attempt number (of two callers one
 * wins), sent with the original key outside any transaction, recorded afterwards. The answer is
 * only a claim: 'claim' tells the caller to read the order again at once.
 */
export async function retryCapture(
  d: PaymentsDeps,
  order: OrderRow,
  op: OperationRow,
  provider_order_id: string,
): Promise<'claim' | 'unknown' | 'reopened' | 'frozen' | 'lost'> {
  const claimed = await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const won = await tx.query(
      `UPDATE operations SET state = 'sent', attempt = attempt + 1, lease_until = $2, next_retry_at = NULL, updated_at = $3
       WHERE id = $1 AND state = 'unknown' AND attempt = $4 RETURNING id`,
      [op.id, addMs(at, d.config.operation_lease_ms), at, op.attempt],
    );
    if (won.rows.length === 0) return false;
    await tx.query(
      "UPDATE orders SET status = 'capture_requested', updated_at = $2 WHERE id = $1 AND status = 'unresolved'",
      [order.id, at],
    );
    return true;
  });
  if (!claimed) return 'lost';

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
    const unknown = async (): Promise<void> => {
      await tx.query(
        `UPDATE operations SET state = 'unknown', lease_until = NULL, next_retry_at = $2, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      await tx.query("UPDATE orders SET status = 'unresolved', updated_at = $2 WHERE id = $1", [
        order.id,
        at,
      ]);
    };
    // The read-back operation of an order that goes back to the buyer or stops has nothing to poll.
    const closeReadback = async (state: 'confirmed' | 'failed'): Promise<void> => {
      await tx.query(
        `UPDATE operations SET state = $2, failure_reason = $3, lease_until = NULL, next_retry_at = NULL, updated_at = $4
         WHERE order_id = $1 AND kind = 'readback' AND state = 'unknown'`,
        [order.id, state, state === 'failed' ? 'mismatch' : null, at],
      );
    };
    const reopen = async (): Promise<void> => {
      await closeReadback('confirmed');
      // Nothing was captured; the buyer has to act at PayPal. Same key, same operation.
      await tx.query(
        `UPDATE operations SET state = 'prepared', lease_until = $2, updated_at = $3 WHERE id = $1`,
        [op.id, addMs(at, d.config.operation_lease_ms), at],
      );
      await tx.query("UPDATE orders SET status = 'awaiting_buyer', updated_at = $2 WHERE id = $1", [
        order.id,
        at,
      ]);
    };
    if (res.kind === 'payer_action') {
      await reopen();
      if (res.redirect_url !== null) {
        await tx.query(
          'UPDATE provider_orders SET approve_url = $2, updated_at = $3 WHERE order_id = $1',
          [order.id, res.redirect_url, at],
        );
      }
      return 'reopened' as const;
    }
    if (res.kind === 'rejected' && res.issue === 'ORDER_NOT_APPROVED') {
      await reopen();
      return 'reopened' as const;
    }
    if (res.kind === 'rejected' && res.issue === 'DUPLICATE_INVOICE_ID') {
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await tx.query(
        "UPDATE orders SET status = 'frozen', mismatch = true, updated_at = $2 WHERE id = $1",
        [order.id, at],
      );
      await closeReadback('failed');
      await raiseOpsAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: null,
        reason: 'duplicate_invoice_id',
        detail: { debug_id: res.debug_id },
      });
      return 'frozen' as const;
    }
    await unknown();
    return res.kind === 'claim' ? ('claim' as const) : ('unknown' as const);
  });
}

/**
 * The create re-send, inside the 5 h window only (the caller checks). Same key as the first send,
 * so PayPal answers with the order it already made. Never charges anything. Recorded like
 * beginCheckout records the first answer.
 */
export async function resendCreate(
  d: PaymentsDeps,
  order: OrderRow,
  op: OperationRow,
): Promise<'confirmed' | 'failed' | 'unknown' | 'lost'> {
  const prepared = await d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const units = await loadUnits(tx, order.id);
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
    return won.rows.length === 0 ? null : req;
  });
  if (prepared === null) return 'lost';

  // Outside any transaction (P14).
  const raw = await d.paypal.createOrder(prepared);
  const parsed = CreateOrderResSchema.safeParse(raw);
  const res: CreateOrderRes = parsed.success ? parsed.data : { kind: 'timeout' };

  return d.db.transaction(async (tx) => {
    const at = d.clock.now().toISOString();
    const unknown = async (): Promise<'unknown'> => {
      await tx.query(
        `UPDATE operations SET state = 'unknown', lease_until = NULL, next_retry_at = $2, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      return 'unknown';
    };
    if (res.kind === 'created') {
      await tx.query(
        `UPDATE provider_orders SET provider_order_id = $2, approve_url = $3, status = $4, updated_at = $5 WHERE order_id = $1`,
        [order.id, res.provider_order_id, res.approve_url, res.status, at],
      );
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      await tx.query(
        "UPDATE orders SET status = 'awaiting_buyer', updated_at = $2 WHERE id = $1 AND status = 'created'",
        [order.id, at],
      );
      return 'confirmed' as const;
    }
    if (res.kind === 'rejected') {
      // Nothing was charged: the order never existed at PayPal.
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await tx.query("UPDATE orders SET status = 'failed', updated_at = $2 WHERE id = $1", [
        order.id,
        at,
      ]);
      await declineUnits(tx, d, order.id, 'create_rejected');
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
