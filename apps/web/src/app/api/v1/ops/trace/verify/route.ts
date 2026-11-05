import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readTraceVerify } from '../../../../../../composition/ops-controls';
import { securityDeps } from '../../../../../../server/access';

// INT-TR1 / TR1.3: the verdict of the journal check (INV-T1 and INV-T2) as counts. Nothing about any row.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/trace/verify',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_trace_verify', per: 'actor', limit: 10, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async ({ actor }) => {
  if (actor.kind !== 'operator')
    return { status: 403, code: 'forbidden', message: 'This key cannot do that.' };
  return { status: 200, body: await readTraceVerify() };
})(securityDeps);
