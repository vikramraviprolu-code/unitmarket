import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { status } from '../../../../api-v1/ops';
import { app, securityDeps } from '../../../../server/access';

// API-A (O5): the public status of the service, /healthz plus revision and db (INT-CL1). No key, no switch, no lock.
export const routeMeta: RouteMeta = {
  path: '/api/v1/status',
  method: 'GET',
  auth: 'public',
  csrf: false,
  rate: { name: 'v1_status', per: 'ip', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async () => status(await app()))(
  securityDeps,
);
