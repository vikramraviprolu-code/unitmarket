import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { caseDetail } from '../../../../../../api-v1/ops-alerts';
import { app, securityDeps } from '../../../../../../server/access';

// INT-AL AL.7: one case. Says only that a message to the buyer exists, never its text.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/cases/[id]',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_case', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(
  routeMeta,
  z.object({ id: IdSchema }).strict(),
  async ({ actor, principal, input }) => caseDetail(await app(), { actor, principal }, input.id),
)(securityDeps);
