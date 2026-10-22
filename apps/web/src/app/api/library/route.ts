import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/library',
  method: 'GET',
  auth: 'buyer',
  csrf: false,
  rate: { name: 'library', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async ({ actor }) => ({
  status: 200,
  body: { items: await (await app()).engine.library({ actor }) },
}))(securityDeps);
