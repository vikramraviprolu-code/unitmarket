import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { startRefusalText } from '../../../../lib/ops-copy';

// WEB-OPS-START (ENH-2): the "Start PayPal" button. An operator session that signed in WITH the
// authenticator code (there is no `fail_safe_without_mfa`: starting widens what the system may do, so
// the wrapper answers 403 mfa_required to an operator without the code), a CSRF token, a reason and
// the scope typed back. It turns the paypal_outbound switch ON and nothing else, and only while an
// active approval row covers it: the same check as `pnpm safety:resume` (resumeOutbound). It cannot
// insert an approval and cannot set UMS_PAYPAL_CONNECT; until that Cloud Run flag is on, no PayPal
// call leaves, and the answer says which way the flag stands.
export const routeMeta: RouteMeta = {
  path: '/api/ops/start',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_start', per: 'actor', limit: 5, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    reason: z.string().trim().min(3).max(200),
    // Typed by the operator; the engine compares it with the scope of the active approval row.
    confirm_scope: z.string().max(100),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.startOutbound({ actor, ...input });
  if (r.ok) return { status: 200, body: r.value };
  const code = r.error;
  const message = startRefusalText(code);
  if (code === 'operator_required') return { status: 403, code: 'mfa_required', message };
  if (code === 'reason_required') return { status: 422, code, message };
  return { status: 409, code, message };
})(securityDeps);
