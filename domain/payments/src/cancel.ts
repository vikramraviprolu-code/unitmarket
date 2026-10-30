// ORDER-A (docs/specs/order-a-cancel-resume.md). A buyer cancels an order that is still waiting for them.
// This is the abandon transition of the due pass (due.ts abandonLocked), started by the buyer, with
// stricter guards: nothing may have been approved, sent or captured, anywhere. It changes nothing in
// capture, refund, webhook or approval, and writes no ledger row (an unpaid order has none).
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Id, OrderRead, PaymentsDeps, Result } from '@umsbx/contracts';
import { abandonLocked } from './due';
import { loadOrder, loadProviderOrders } from './store';

export type CancelError = {
  /**
   * not_found: no such order for this buyer (another buyer's order and a guessed id answer alike).
   * wrong_state: the order is not waiting for its buyer (paid, failed, frozen, or checkout not begun).
   * payment_started: a PayPal order was approved or may be captured; it is finished, not cancelled.
   * unavailable: PayPal cannot be asked right now, so nothing is changed; try again.
   */
  code: 'not_found' | 'wrong_state' | 'payment_started' | 'unavailable';
};
export type CancelOk = { order_ref: Id; status: 'abandoned'; already: boolean };

// A PayPal order in one of these statuses can no longer be approved or captured by anyone.
const CANNOT_CAPTURE = new Set(['CREATED', 'VOIDED']);

export async function cancelOrder(
  d: PaymentsDeps,
  i: { order_id: Id; actor: Actor },
): Promise<Result<CancelOk, CancelError>> {
  if (i.actor.kind !== 'buyer' || !IdSchema.safeParse(i.order_id).success) {
    return err({ code: 'not_found' });
  }
  const order = await loadOrder(d.db, i.order_id);
  // Another buyer's order answers exactly as a missing one (A-20).
  if (order === null || order.buyer_id !== i.actor.buyer_id) return err({ code: 'not_found' });
  // Cancelling twice is harmless, and so is cancelling what the sweep already abandoned.
  if (order.status === 'abandoned') {
    return ok({ order_ref: order.order_ref, status: 'abandoned', already: true });
  }
  if (order.status !== 'awaiting_buyer') return err({ code: 'wrong_state' });
  // Reading the PayPal orders is an outbound call, as in the sweep: switched off means we cannot know.
  if (!(await d.switches.isOn('paypal_outbound'))) return err({ code: 'unavailable' });

  const pos = await loadProviderOrders(d.db, order.id);
  // Seen as approved here: finished, not cancelled. (Read again under the lock below.)
  if (pos.some((p) => p.state !== 'prepared' && p.state !== 'awaiting_buyer')) {
    return err({ code: 'payment_started' });
  }
  let gone = false;
  for (const po of pos) {
    if (po.provider_order_id === null) continue;
    const read: OrderRead = await d.paypal.getOrder(po.provider_order_id);
    if (read.kind === 'not_found') {
      gone = true; // PayPal does not know it: nothing can be captured on it
      continue;
    }
    // Blocked, timed out, unreadable: fail closed.
    if (read.kind !== 'order') return err({ code: 'unavailable' });
    if (read.units.some((u) => u.capture !== null) || !CANNOT_CAPTURE.has(read.status)) {
      return err({ code: 'payment_started' });
    }
  }

  const done = await abandonLocked(d, order, gone, { actor: i.actor });
  if (done === 'abandoned') {
    d.log.log({
      msg: 'payments.cancel.by_buyer',
      level: 'info',
      fields: { order_ref: order.order_ref },
    });
    return ok({ order_ref: order.order_ref, status: 'abandoned', already: false });
  }
  // Under the lock the order had moved or something was in flight: say which, from the stored state.
  const now = await loadOrder(d.db, order.id);
  if (now?.status === 'abandoned') {
    return ok({ order_ref: order.order_ref, status: 'abandoned', already: true });
  }
  return err({ code: done === 'handled' ? 'wrong_state' : 'payment_started' });
}
