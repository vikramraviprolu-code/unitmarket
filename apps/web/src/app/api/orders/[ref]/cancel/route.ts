import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { CANCEL_ANSWER } from '../../../../../lib/order-actions';

// ORDER-A (docs/specs/order-a-cancel-resume.md): a buyer cancels their own unpaid order. The engine
// decides: only the owner, only an order still waiting for the buyer, only when no PayPal order was
// approved or could still be captured. Cancelling twice is the same answer, so no Idempotency-Key is needed.
export const routeMeta: RouteMeta = {
  path: '/api/orders/[ref]/cancel',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'order-cancel', per: 'actor', limit: 5, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ ref: z.string().min(1).max(200) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const a = await app();
  const order = await a.engine.orderView({ order_ref: input.ref, actor });
  // Another buyer's order and a missing one answer the same (A-20).
  if (order === null)
    return { status: 404, code: 'not_found', message: 'We could not find that order.' };
  const r = await a.engine.payments.cancelOrder({ order_id: order.order_id, actor });
  if (r.ok) return { status: 200, body: r.value };
  switch (r.error.code) {
    case 'not_found':
      return { status: 404, code: 'not_found', message: 'We could not find that order.' };
    case 'unavailable':
      return { status: 503, code: 'unavailable', message: CANCEL_ANSWER.unavailable };
    case 'payment_started':
      return { status: 409, code: 'payment_started', message: CANCEL_ANSWER.payment_started };
    default:
      return { status: 409, code: 'wrong_state', message: CANCEL_ANSWER.wrong_state };
  }
})(securityDeps);
