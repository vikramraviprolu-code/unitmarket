import { AlertListQuerySchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { alertList } from '../../../../../api-v1/ops-alerts';
import { app, securityDeps } from '../../../../../server/access';

// INT-AL AL.1: see src/api-v1/ops-alerts.ts. A bearer key with the scope below; reads only.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/alerts',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_alerts', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, AlertListQuerySchema, async ({ actor, principal, input }) =>
  alertList(await app(), { actor, principal }, input),
)(securityDeps);
