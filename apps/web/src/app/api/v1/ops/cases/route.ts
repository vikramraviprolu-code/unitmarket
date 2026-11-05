import { CaseListQuerySchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { caseList } from '../../../../../api-v1/ops-alerts';
import { app, securityDeps } from '../../../../../server/access';

// INT-AL AL.7: the case queue. A bearer key with the scope below; reads only.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/cases',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_cases', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, CaseListQuerySchema, async ({ actor, principal, input }) =>
  caseList(await app(), { actor, principal }, input),
)(securityDeps);
