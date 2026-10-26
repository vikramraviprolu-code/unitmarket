// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/place.ts (sendCreate) at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// P2: beginCheckout. The create operation is locked and set `sent` in one transaction; the
// provider is called outside any transaction with the stored request id; the answer is recorded in
// a second transaction. The request is rebuilt from the stored order and units, never from a
// response.
import { applyMoneyEvent } from '@umsbx/entitlements';
import {
  CreateOrderReqSchema,
  CreateOrderResSchema,
  IdSchema,
  err,
  isUrlUnderOrigin,
  ok,
} from '@umsbx/contracts';
import type {
  Actor,
  CreateOrderReq,
  CreateOrderRes,
  Id,
  PaymentsDeps,
  Result,
} from '@umsbx/contracts';
import { raiseAlert } from './alerts';
import { endWholeOrder, lockGraph, refreshOrder } from './composite';
import { addMs, backoffMs, loadOperationFor, loadOrder, loadUnits, unitsOf } from './store';
import type { OperationRow, ProviderOrderRow } from './store';

type CheckoutError = {
  code: 'not_found' | 'wrong_state' | 'create_failed' | 'payments_paused';
};
type CheckoutOk = { approve_url: string; progress?: { step: number; of: number } };
class Stop extends Error {}

/**
 * Where the buyer goes next: the first PayPal order still awaiting the buyer, else the first one
 * approved again after payer_action. "Step k of N" is only said for a pack.
 */
export function nextApproval(
  pos: readonly ProviderOrderRow[],
): { po: ProviderOrderRow; approve_url: string } | null {
  for (const wanted of ['awaiting_buyer', 'approved'] as const) {
    const po = pos.find((p) => p.state === wanted && p.approve_url !== null);
    if (po !== undefined) return { po, approve_url: po.approve_url as string };
  }
  return null;
}
const answerOf = (pos: readonly ProviderOrderRow[]): CheckoutOk | null => {
  const next = nextApproval(pos);
  if (next === null) return null;
  return pos.length > 1
    ? { approve_url: next.approve_url, progress: { step: next.po.position, of: pos.length } }
    : { approve_url: next.approve_url };
};

/**
 * P2: beginCheckout, eager (OQ-3). Every PayPal order of the order is created before the buyer goes to
 * PayPal. For each one, in position order: the create operation is locked and set `sent` in one
 * transaction; the provider is called outside any transaction with the stored request id; the answer is
 * recorded in a second transaction. The request is rebuilt from the stored order and units, never from a
 * response. One unit per create for a pack (custom_id = order_ref, invoice_id = po_ref). A create that is
 * refused fails the whole order; a duplicate invoice id freezes it.
 */
export async function beginCheckout(
  d: PaymentsDeps,
  i: { order_id: Id; actor: Actor; scenario?: string | null },
): Promise<Result<CheckoutOk, CheckoutError>> {
  const scenario = i.scenario ?? null;
  const actor = i.actor;
  if (!IdSchema.safeParse(i.order_id).success) return err({ code: 'not_found' });
  const first = await loadOrder(d.db, i.order_id);
  if (first === null || actor.kind !== 'buyer' || actor.buyer_id !== first.buyer_id) {
    return err({ code: 'not_found' });
  }
  // The switch is read outside any transaction: the port may use the database itself.
  if (!(await d.switches.isOn('checkout_enabled'))) return err({ code: 'payments_paused' });

  type Prepared =
    | { kind: 'send'; req: CreateOrderReq; op: OperationRow; po: ProviderOrderRow }
    | { kind: 'done'; result: Result<CheckoutOk, CheckoutError> };
  for (;;) {
    const prepared = await d.db
      .transaction(async (tx): Promise<Prepared> => {
        const { order, pos } = await lockGraph(tx, i.order_id);
        if (order.status === 'awaiting_buyer') {
          // A repeat of a finished checkout: the same answer, no further PayPal order.
          const answer = answerOf(pos);
          if (answer !== null) return { kind: 'done', result: ok(answer) };
        }
        if (order.status !== 'created') {
          return { kind: 'done', result: err({ code: 'wrong_state' }) };
        }
        const po = pos.find((p) => p.state === 'prepared');
        if (po === undefined) return { kind: 'done', result: err({ code: 'wrong_state' }) };
        const op = await loadOperationFor(tx, po, 'create', { lock: true });
        if (op === null || op.state !== 'prepared') {
          return { kind: 'done', result: err({ code: 'wrong_state' }) };
        }
        const units = unitsOf(await loadUnits(tx, order.id), po);
        const at = d.clock.now().toISOString();
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
          scenario,
          // A pack: one unit per create, and the invoice id of the PayPal order is its po_ref, so
          // two PayPal orders of one order never collide on DUPLICATE_INVOICE_ID. A single order
          // sends no invoice_id (the adapter derives it from order_ref, exactly as before).
          ...(po.route === 'single' ? {} : { invoice_id: po.po_ref }),
        });
        const sent = await tx.query(
          `UPDATE operations SET state = 'sent', first_sent_at = COALESCE(first_sent_at, $2),
           idem_safe_until = COALESCE(idem_safe_until, $3), lease_until = $4, updated_at = $2
         WHERE id = $1 AND state = 'prepared' RETURNING id`,
          [
            op.id,
            at,
            addMs(at, d.config.idem_safe_window_ms),
            addMs(at, d.config.operation_lease_ms),
          ],
        );
        if (sent.rows.length === 0) throw new Stop();
        return { kind: 'send', req, op, po };
      })
      .catch((e: unknown) => {
        if (e instanceof Stop)
          return { kind: 'done', result: err({ code: 'wrong_state' }) } as Prepared;
        throw e;
      });
    if (prepared.kind === 'done') return prepared.result;

    // Outside any transaction (P14).
    const raw = await d.paypal.createOrder(prepared.req);
    const parsed = CreateOrderResSchema.safeParse(raw);
    const res: CreateOrderRes = parsed.success ? parsed.data : { kind: 'timeout' };

    const failed = await recordCreate(d, i.order_id, prepared.po, res);
    if (failed !== null) return failed;
    // This PayPal order exists; go on with the next one, or answer when none is left.
  }
}

/** Records the answer to one create. Null: created, go on. A result: stop with it. */
async function recordCreate(
  d: PaymentsDeps,
  order_id: Id,
  po: ProviderOrderRow,
  res: CreateOrderRes,
): Promise<Result<CheckoutOk, CheckoutError> | null> {
  return d.db.transaction(async (tx): Promise<Result<CheckoutOk, CheckoutError> | null> => {
    const at = d.clock.now().toISOString();
    const { order } = await lockGraph(tx, order_id);
    const op = await loadOperationFor(tx, po, 'create', { lock: true });
    if (op === null) throw new Error(`create operation of ${order.id} vanished`);

    if (res.kind === 'created') {
      await tx.query(
        `UPDATE provider_orders SET provider_order_id = $2, approve_url = $3, status = $4, state = 'awaiting_buyer', updated_at = $5
          WHERE id = $1 AND state = 'prepared'`,
        [po.id, res.provider_order_id, res.approve_url, res.status, at],
      );
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      await refreshOrder(tx, d, order.id);
      return null;
    }
    if (res.kind === 'rejected' && res.issue === 'DUPLICATE_INVOICE_ID') {
      // PayPal already has an order for this reference: a suspected duplicate. Nothing is declined
      // and nothing is retried; the whole order is frozen for a human (architecture 5, error table).
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await endWholeOrder(tx, d, order.id, 'frozen');
      await raiseAlert(tx, d, {
        kind: 'frozen_order',
        order_id: order.id,
        unit_id: null,
        reason: 'duplicate_invoice_id',
        detail: { phase: 'create', debug_id: res.debug_id },
      });
      return err({ code: 'create_failed' });
    }
    if (res.kind === 'rejected') {
      // Nothing was charged: nothing was approved, and the whole order fails (no order of it is kept
      // beside a refused one).
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await endWholeOrder(tx, d, order.id, 'failed');
      for (const unit of await loadUnits(tx, order.id)) {
        await tx.query(
          `UPDATE order_units SET status = 'declined', status_reason = 'create_rejected', updated_at = $2 WHERE id = $1`,
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
      await raiseAlert(tx, d, {
        kind: 'create_rejected',
        order_id: order.id,
        unit_id: null,
        reason: `${res.http}_${res.issue ?? res.name}`,
        detail: { http: res.http, name: res.name, debug_id: res.debug_id },
      });
      return err({ code: 'create_failed' });
    }
    // timeout, unavailable, in_progress, blocked, and the replies that cannot be right at create
    // (not_found, payer_action): the order may exist at PayPal. Never assume it does not; the
    // reconciler (lane 05b) resends with the same key inside the safe window, then reads.
    const sentAt = op.first_sent_at ?? at;
    const reconcile_until = addMs(sentAt, d.config.reconcile_window_ms);
    const wait =
      res.kind === 'unavailable' && res.retry_after_ms !== null
        ? Math.max(res.retry_after_ms, backoffMs(d.config, 1))
        : backoffMs(d.config, 1);
    await tx.query(
      `UPDATE operations SET state = 'unknown', lease_until = NULL, reconcile_until = $2, next_retry_at = $3, updated_at = $4 WHERE id = $1`,
      [op.id, reconcile_until, addMs(at, wait), at],
    );
    if (res.kind === 'blocked') return err({ code: 'payments_paused' });
    return err({ code: 'create_failed' });
  });
}
