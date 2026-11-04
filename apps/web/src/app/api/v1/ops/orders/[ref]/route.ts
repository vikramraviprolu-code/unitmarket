import { OpsOrderRefParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { orderDetail } from '../../../../../../api-v1/ops';
import { app, securityDeps } from '../../../../../../server/access';

// API-A (ops): see src/api-v1/ops.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/orders/[ref]',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_order', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(
  routeMeta,
  OpsOrderRefParamSchema,
  async ({ actor, principal, input }) => orderDetail(await app(), { actor, principal }, input.ref),
)(securityDeps);
