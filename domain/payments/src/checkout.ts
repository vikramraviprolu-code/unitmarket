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
import { addMs, backoffMs, loadOperation, loadOrder, loadProviderOrders, loadUnits } from './store';
import type { OperationRow } from './store';

type CheckoutError = {
  code: 'not_found' | 'wrong_state' | 'create_failed' | 'payments_paused';
};
class Stop extends Error {}

export async function beginCheckout(
  d: PaymentsDeps,
  i: { order_id: Id; actor: Actor; scenario?: string | null },
): Promise<Result<{ approve_url: string }, CheckoutError>> {
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
    | { kind: 'send'; req: CreateOrderReq; op: OperationRow; provider_row: Id }
    | { kind: 'done'; result: Result<{ approve_url: string }, CheckoutError> };
  const prepared = await d.db
    .transaction(async (tx): Promise<Prepared> => {
      const order = await loadOrder(tx, i.order_id, { lock: true });
      if (order === null) return { kind: 'done', result: err({ code: 'not_found' }) };
      const providers = await loadProviderOrders(tx, order.id);
      const provider = providers[0];
      if (provider === undefined) throw new Error(`order ${order.id} has no provider order row`);
      if (order.status === 'awaiting_buyer' && provider.approve_url !== null) {
        // A repeat of a finished checkout: the same answer, no second PayPal order.
        return { kind: 'done', result: ok({ approve_url: provider.approve_url }) };
      }
      if (order.status !== 'created') return { kind: 'done', result: err({ code: 'wrong_state' }) };
      const op = await loadOperation(tx, order.id, 'create', { lock: true });
      if (op === null || op.state !== 'prepared') {
        return { kind: 'done', result: err({ code: 'wrong_state' }) };
      }
      const units = await loadUnits(tx, order.id);
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
      return { kind: 'send', req, op, provider_row: provider.id };
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

  return d.db.transaction(async (tx): Promise<Result<{ approve_url: string }, CheckoutError>> => {
    const at = d.clock.now().toISOString();
    const order = await loadOrder(tx, i.order_id, { lock: true });
    if (order === null) throw new Error(`order ${i.order_id} vanished`);
    const op = await loadOperation(tx, order.id, 'create', { lock: true });
    if (op === null) throw new Error(`create operation of ${order.id} vanished`);

    if (res.kind === 'created') {
      await tx.query(
        `UPDATE provider_orders SET provider_order_id = $2, approve_url = $3, status = $4, updated_at = $5 WHERE id = $1`,
        [prepared.provider_row, res.provider_order_id, res.approve_url, res.status, at],
      );
      await tx.query(
        `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL, updated_at = $2 WHERE id = $1`,
        [op.id, at],
      );
      await tx.query(
        `UPDATE orders SET status = 'awaiting_buyer', updated_at = $2 WHERE id = $1 AND status = 'created'`,
        [order.id, at],
      );
      return ok({ approve_url: res.approve_url });
    }
    if (res.kind === 'rejected') {
      // Nothing was charged: the order never existed at PayPal.
      await tx.query(
        `UPDATE operations SET state = 'failed', failure_reason = $2, lease_until = NULL, next_retry_at = NULL, updated_at = $3 WHERE id = $1`,
        [op.id, res.http === 400 ? 'invalid_request' : 'rejected', at],
      );
      await tx.query(`UPDATE orders SET status = 'failed', updated_at = $2 WHERE id = $1`, [
        order.id,
        at,
      ]);
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
