import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { opsFind } from '../../../../api-v1/ops';
import { app, securityDeps } from '../../../../server/access';

// INT-SR1 (SR1.4): quick-find for a signed-in operator, 30 a minute per actor. The query is never logged
// (the route logger keeps the path only). The buyer group appears only with MFA.
export const routeMeta: RouteMeta = {
  path: '/api/ops/find',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_find', per: 'actor', limit: 30, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ q: z.string().max(400).default('') }).strict();

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) =>
  opsFind(await app(), actor, input.q),
)(securityDeps);
