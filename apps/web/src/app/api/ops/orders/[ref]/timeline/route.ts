import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readOpsTimeline } from '../../../../../../composition/ops-controls';
import { securityDeps } from '../../../../../../server/access';

// INT-TR1 / TR1.2: every step of one order for an operator session. The second factor adds the actor id,
// request id, address prefix, family and key id; without it the operator view hides them.
export const routeMeta: RouteMeta = {
  path: '/api/ops/orders/[ref]/timeline',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_order_timeline', per: 'actor', limit: 60, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ ref: z.string().min(1).max(200) }).strict();

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  if (actor.kind !== 'operator')
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  const t = await readOpsTimeline(input.ref, actor.mfa);
  return t === null
    ? { status: 404, code: 'not_found', message: 'We could not find that order.' }
    : { status: 200, body: t };
})(securityDeps);
