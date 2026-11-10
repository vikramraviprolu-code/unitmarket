import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

// OPS-SW (D-120): the "Open a PayPal sitting" button. An operator session that signed in WITH the
// authenticator code (no `fail_safe_without_mfa`: it widens what the system may do, so the wrapper answers
// 403 mfa_required without the code), a CSRF token and a reason. It writes one approval row with the D-094
// ceiling fixed in code (five operations, 500 minor units per order, 40 calls, four hours) under a fresh
// reference, and nothing else: Start turns PayPal on, and the Cloud Run connection flag is untouched. The
// body carries no limit, so no caller can widen the ceiling.
export const routeMeta: RouteMeta = {
  path: '/api/ops/sitting',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_sitting', per: 'actor', limit: 5, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.openSitting({ actor, reason: input.reason });
  if (r.ok) return { status: 200, body: r.value };
  switch (r.error) {
    case 'operator_required':
      return {
        status: 403,
        code: 'mfa_required',
        message: 'Opening a PayPal sitting needs a sign-in with your authenticator code.',
      };
    case 'reason_required':
      return {
        status: 422,
        code: 'reason_required',
        message: 'Please say why you are opening it.',
      };
    case 'no_reference':
      return {
        status: 409,
        code: 'no_reference',
        message: 'This app has no approval reference set, so no sitting can be opened.',
      };
    default:
      return {
        status: 409,
        code: 'sitting_active',
        message: 'A PayPal sitting is already open. Use Start, or wait until it ends.',
      };
  }
})(securityDeps);
