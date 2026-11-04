import { OrderRefParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { cancelOrder } from '../../../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/orders/[ref]/cancel',
  method: 'POST',
  auth: 'apikey',
  scopes: ['orders:write'],
  csrf: false,
  rate: { name: 'v1_order_cancel', per: 'actor', limit: 5, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(routeMeta, OrderRefParamSchema, async ({ actor, principal, input }) =>
  cancelOrder(await app(), { actor, principal }, input.ref),
)(securityDeps);
