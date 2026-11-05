import { IdSchema, AlertResolveBodySchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import { alertErrorResult } from '../../../../../../lib/alerts-http';

// INT-AL AL.8: an operator resolves one alert. An operator session WITH the second factor (the wrapper answers
// 403 mfa_required to any other operator), CSRF and an Idempotency-Key. The journal records who and when.
export const routeMeta: RouteMeta = {
  path: '/api/ops/alerts/[id]/resolve',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_alert_resolve', per: 'actor', limit: 600, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

const Input = AlertResolveBodySchema.extend({ id: IdSchema }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.opsAlerts.resolve({
    actor,
    alert_id: input.id,
    reason_code: input.reason_code,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  return r.ok ? { status: 200, body: r.value } : alertErrorResult(r.error.code);
})(securityDeps);
