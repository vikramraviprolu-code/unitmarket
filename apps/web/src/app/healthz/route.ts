import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../server/access';

export const routeMeta: RouteMeta = {
  path: '/healthz',
  method: 'GET',
  auth: 'public',
  csrf: false,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async () => {
  const h = await (await app()).engine.health();
  return h.ok
    ? { status: 200, body: { ok: true, environment: h.environment } }
    : { status: 503, code: 'unhealthy', message: 'The service is not ready.' };
})(securityDeps);
