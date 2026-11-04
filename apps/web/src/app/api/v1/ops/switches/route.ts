import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { switches } from '../../../../../api-v1/ops';
import { app, securityDeps } from '../../../../../server/access';

// API-A (ops): see src/api-v1/ops.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/switches',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_switches', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async ({ actor, principal }) =>
  switches(await app(), { actor, principal }),
)(securityDeps);
