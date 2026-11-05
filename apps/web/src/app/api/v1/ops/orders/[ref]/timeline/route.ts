import { OpsOrderRefParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readOpsTimeline } from '../../../../../../../composition/ops-controls';
import { securityDeps } from '../../../../../../../server/access';

// INT-TR1 / TR1.3: every step of one order for an operator key. A key never has the second factor, so no
// request id, address, family, key id or actor id of a buyer or seller appears.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/orders/[ref]/timeline',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_timeline', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, OpsOrderRefParamSchema, async ({ actor, input }) => {
  if (actor.kind !== 'operator')
    return { status: 403, code: 'forbidden', message: 'This key cannot do that.' };
  const t = await readOpsTimeline(input.ref, false);
  return t === null
    ? { status: 404, code: 'not_found', message: 'We could not find that order.' }
    : { status: 200, body: t };
})(securityDeps);
