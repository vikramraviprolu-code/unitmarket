import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readBuyerTimeline } from '../../../../../../composition/buyer';
import { securityDeps } from '../../../../../../server/access';

// INT-TR1 / TR1.3: the steps of one order, for the buyer key or agent key that owns it. Another buyer's order and
// an unknown one answer the same 404.
export const routeMeta: RouteMeta = {
  path: '/api/v1/orders/[ref]/timeline',
  method: 'GET',
  auth: 'apikey',
  scopes: ['orders:read'],
  csrf: false,
  rate: { name: 'v1_order_timeline', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Param = z.object({ ref: z.string().min(1).max(200) }).strict();

export const GET = withRoute(routeMeta, Param, async ({ actor, input }) => {
  if (actor.kind !== 'buyer')
    return { status: 403, code: 'forbidden', message: 'This key cannot do that.' };
  const t = await readBuyerTimeline(actor.buyer_id, input.ref);
  return t === null
    ? { status: 404, code: 'not_found', message: 'We could not find that order.' }
    : { status: 200, body: t };
})(securityDeps);
