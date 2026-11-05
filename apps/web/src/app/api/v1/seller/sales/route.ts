import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { TxnQueryMapSchema } from '@umsbx/contracts';
import { listSales } from '../../../../../api-v1/seller';
import { app, securityDeps } from '../../../../../server/access';

// API-A (seller): see src/api-v1/seller.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/seller/sales',
  method: 'GET',
  auth: 'apikey',
  scopes: ['sales:read'],
  csrf: false,
  rate: { name: 'v1_sales', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, principal, input }) =>
  listSales(await app(), { actor, principal }, input),
)(securityDeps);
