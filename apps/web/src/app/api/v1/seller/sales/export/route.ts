import { TxnQueryMapSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { exportSales } from '../../../../../../api-v1/seller';
import { app, securityDeps } from '../../../../../../server/access';

// INT-SR1 (SR1.5): the seller's sales under the current filter as CSV text in a JSON answer. No buyer column.
export const routeMeta: RouteMeta = {
  path: '/api/v1/seller/sales/export',
  method: 'GET',
  auth: 'apikey',
  scopes: ['sales:read'],
  csrf: false,
  rate: { name: 'v1_sales_export', per: 'actor', limit: 10, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, principal, input }) =>
  exportSales(await app(), { actor, principal }, input),
)(securityDeps);
