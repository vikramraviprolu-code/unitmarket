import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, securityDeps } from '../../../../../../server/access';
import { alertErrorResult } from '../../../../../../lib/alerts-http';

// INT-AL AL.8: an operator acknowledges one alert. An operator session WITH the second factor (the wrapper answers
// 403 mfa_required to any other operator), CSRF and an Idempotency-Key. The journal records who and when.
export const routeMeta: RouteMeta = {
  path: '/api/ops/alerts/[id]/acknowledge',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_alert_acknowledge', per: 'actor', limit: 600, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

const Input = z.object({ id: IdSchema }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsAlerts.acknowledge({ actor, alert_id: input.id });
  return r.ok ? { status: 200, body: r.value } : alertErrorResult(r.error.code);
})(securityDeps);
