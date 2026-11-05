import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { needsYouList } from '../../../../../api-v1/ops-alerts';
import { app, securityDeps } from '../../../../../server/access';

// INT-AL AL.6: what needs the operator, one sentence and one link each. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/needs-you',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_needs_you', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async ({ actor, principal }) =>
  needsYouList(await app(), { actor, principal }),
)(securityDeps);
