import { OrderListQuerySchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { exportOrders } from '../../../../../api-v1/buyer';

// INT-SR1 (SR1.5): the buyer's lines under the current filter as CSV text in a JSON answer (PUB-E1 shape).
export const routeMeta: RouteMeta = {
  path: '/api/v1/orders/export',
  method: 'GET',
  auth: 'apikey',
  scopes: ['orders:read'],
  csrf: false,
  rate: { name: 'v1_order_export', per: 'actor', limit: 10, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, OrderListQuerySchema, async ({ actor, principal, input }) =>
  exportOrders(await app(), { actor, principal }, input),
)(securityDeps);
