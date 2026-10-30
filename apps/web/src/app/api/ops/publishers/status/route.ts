import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { statusErrorText } from '../../../../../lib/ops-publishers-copy';

// PUB-D: an operator suspends or reactivates one publisher. An operator session WITH the second factor
// (the wrapper answers 403 mfa_required to any other operator; there is no `fail_safe_without_mfa`),
// CSRF, a reason. A publisher or buyer session is refused by the wrapper (wrong role). Only the
// publisher id, the new status and the reason are read: nothing else is accepted. Orders, access and
// refunds are not changed; the audit row carries the operator, the reason and the old and new status.
export const routeMeta: RouteMeta = {
  path: '/api/ops/publishers/status',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'publisher_status', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    publisher_id: z.string().min(1).max(100),
    status: z.enum(['suspended', 'active']),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsPublishers.setStatus({ actor, ...input });
  if (r.ok) return { status: 200, body: { status: r.value.status } };
  const code = r.error.code;
  const message = statusErrorText(code);
  switch (code) {
    case 'not_found':
      return { status: 404, code, message };
    case 'unchanged':
    case 'not_allowed':
      return { status: 409, code, message };
    case 'invalid_input':
      return { status: 422, code, message };
    default:
      return { status: 403, code: code === 'mfa_required' ? code : 'forbidden', message };
  }
})(securityDeps);
