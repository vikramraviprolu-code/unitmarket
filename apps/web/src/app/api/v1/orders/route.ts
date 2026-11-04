import { OrderListQuerySchema, OrderPlaceRequestSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { listOrders, placeOrder } from '../../../../api-v1/buyer';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMetaGET: RouteMeta = {
  path: '/api/v1/orders',
  method: 'GET',
  auth: 'apikey',
  scopes: ['orders:read'],
  csrf: false,
  rate: { name: 'v1_order_list', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(
  routeMetaGET,
  OrderListQuerySchema,
  async ({ actor, principal, input }) => listOrders(await app(), { actor, principal }, input),
)(securityDeps);

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMetaPOST: RouteMeta = {
  path: '/api/v1/orders',
  method: 'POST',
  auth: 'apikey',
  scopes: ['orders:write'],
  csrf: false,
  rate: { name: 'v1_order', per: 'actor', limit: 20, window_ms: 60000 },
  max_body_bytes: 2048,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(
  routeMetaPOST,
  OrderPlaceRequestSchema,
  async ({ actor, principal, input }) => placeOrder(await app(), { actor, principal }, input),
)(securityDeps);
