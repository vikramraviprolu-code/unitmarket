import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { alertDetail } from '../../../../../../api-v1/ops-alerts';
import { app, securityDeps } from '../../../../../../server/access';

// INT-AL AL.1: one alert with its history. A bearer key with the scope below; reads only.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/alerts/[id]',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_alert', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(
  routeMeta,
  z.object({ id: IdSchema }).strict(),
  async ({ actor, principal, input }) => alertDetail(await app(), { actor, principal }, input.id),
)(securityDeps);
