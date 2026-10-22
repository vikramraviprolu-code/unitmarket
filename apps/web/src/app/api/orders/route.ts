import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/orders',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'order', per: 'actor', limit: 5, window_ms: 60_000 },
  max_body_bytes: 2048,
  idempotent: true,
  risk: 'high',
};

const Input = z
  .object({ approval_id: z.string().min(1).max(200), token: z.string().min(20).max(400) })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.payments.placeOrder({ ...input, actor });
  if (r.ok) return { status: 201, body: r.value };
  const e = r.error;
  if (e.code === 'order_open')
    return { status: 409, code: 'order_open', message: 'You already have an open order for this.' };
  if (e.code === 'checkout_off')
    return {
      status: 503,
      code: 'checkout_off',
      message: 'Checkout is paused. Nothing was charged.',
    };
  return { status: e.http, code: 'approval', message: 'That approval can no longer be used.' };
})(securityDeps);
