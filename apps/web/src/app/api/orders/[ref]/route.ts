import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/orders/[ref]',
  method: 'GET',
  auth: 'buyer',
  csrf: false,
  rate: { name: 'order-read', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ ref: z.string().min(1).max(200) }).strict();

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const v = await (await app()).engine.orderView({ order_ref: input.ref, actor });
  // Another buyer's order and a missing one answer the same (A-20).
  return v === null
    ? { status: 404, code: 'not_found', message: 'We could not find that order.' }
    : { status: 200, body: v };
})(securityDeps);
