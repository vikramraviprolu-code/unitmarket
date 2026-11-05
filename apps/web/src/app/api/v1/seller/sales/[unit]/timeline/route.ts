import { SellerUnitParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readSellerTimeline } from '../../../../../../../composition/seller';
import { securityDeps } from '../../../../../../../server/access';

// INT-TR1 / TR1.3: the steps of one unit, for the seller key that sold it. Another seller's unit and an unknown
// one answer the same 404. No buyer, no order total and no other unit appears.
export const routeMeta: RouteMeta = {
  path: '/api/v1/seller/sales/[unit]/timeline',
  method: 'GET',
  auth: 'apikey',
  scopes: ['sales:read'],
  csrf: false,
  rate: { name: 'v1_sale_timeline', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, SellerUnitParamSchema, async ({ actor, input }) => {
  if (actor.kind !== 'publisher')
    return { status: 403, code: 'forbidden', message: 'This key cannot do that.' };
  const t = await readSellerTimeline(actor.publisher_id, input.unit);
  return t === null
    ? { status: 404, code: 'not_found', message: 'We could not find that sale.' }
    : { status: 200, body: t };
})(securityDeps);
