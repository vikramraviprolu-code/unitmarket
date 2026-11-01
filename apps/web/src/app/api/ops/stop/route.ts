import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

// BU-2: the "Stop PayPal now" button. An operator session, a CSRF token and a reason; it turns the
// paypal_outbound switch OFF and nothing else (it cannot turn anything on: turning it on is
// POST /api/ops/start, which needs the authenticator code, or `pnpm safety:resume` at the owner's
// terminal). It sets fail_safe_without_mfa because stopping only reduces what the system may do, and
// the demo operator has no second factor yet.
export const routeMeta: RouteMeta = {
  path: '/api/ops/stop',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_stop', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
  fail_safe_without_mfa: true,
};

const Input = z.object({ reason: z.string().trim().min(1).max(200) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.stopOutbound({ actor, reason: input.reason });
  if (r.ok) return { status: 200, body: { outbound_on: false } };
  return r.error === 'operator_required'
    ? { status: 403, code: 'forbidden', message: 'This account cannot do that.' }
    : { status: 422, code: 'reason_required', message: 'Please say why you are stopping.' };
})(securityDeps);
