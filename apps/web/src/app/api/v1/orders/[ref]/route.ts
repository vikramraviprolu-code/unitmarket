import { OrderRefParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { getOrder } from '../../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/orders/[ref]',
  method: 'GET',
  auth: 'apikey',
  scopes: ['orders:read'],
  csrf: false,
  rate: { name: 'v1_order_read', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, OrderRefParamSchema, async ({ actor, principal, input }) =>
  getOrder(await app(), { actor, principal }, input.ref),
)(securityDeps);
