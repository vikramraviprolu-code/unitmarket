import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/orders/[ref]/checkout',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'order', per: 'actor', limit: 5, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

// `scenario` selects a dry-run fixture scenario; it only has an effect in dry-run mode.
const Input = z
  .object({ ref: z.string().min(1).max(200), scenario: z.string().min(1).max(60).optional() })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const a = await app();
  const order = await a.engine.orderView({ order_ref: input.ref, actor });
  if (order === null)
    return { status: 404, code: 'not_found', message: 'We could not find that order.' };
  const r = await a.engine.payments.beginCheckout({
    order_id: order.order_id,
    actor,
    scenario: a.environment === 'dryrun' ? (input.scenario ?? null) : null,
  });
  if (r.ok) return { status: 200, body: { approve_url: r.value.approve_url } };
  return r.error.code === 'payments_not_wired'
    ? { status: 503, code: 'payments_not_wired', message: 'Checkout is not available yet.' }
    : { status: 409, code: r.error.code, message: 'This order cannot go to checkout now.' };
})(securityDeps);
