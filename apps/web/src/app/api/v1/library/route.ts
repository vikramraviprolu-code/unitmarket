import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { listLibrary } from '../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/library',
  method: 'GET',
  auth: 'apikey',
  scopes: ['library:read'],
  csrf: false,
  rate: { name: 'v1_library', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async ({ actor, principal }) =>
  listLibrary(await app(), { actor, principal }),
)(securityDeps);
