import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { accessErrorText } from '../../../../../lib/publisher-accounts-copy';

// POB-P1: an operator issues (or replaces) an invite code for an active publisher with no account, or resets the
// sign in of a publisher with one (removes the account and ends its sessions, then issues a new code). Operator
// session WITH the second factor, CSRF, a reason of 3 to 200 characters. The new code is in this answer and
// nowhere else: it is not stored, logged or audited in clear, and the answer is not cached. The demo publishers
// are refused (not_allowed). Orders, units, access and the ledger are not touched.
export const routeMeta: RouteMeta = {
  path: '/api/ops/publishers/access',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'publisher_access', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    publisher_id: z.string().min(1).max(100),
    action: z.enum(['issue', 'reset']),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const e = (await app()).engine.opsPublisherAccess;
  const args = { actor, publisher_id: input.publisher_id, reason: input.reason };
  const r = input.action === 'issue' ? await e.issue(args) : await e.reset(args);
  if (r.ok)
    return {
      status: 200,
      body: { invite: { code: r.value.code, expires_at: r.value.expires_at } },
      headers: { 'cache-control': 'no-store' },
    };
  const code = r.error.code;
  const message = accessErrorText(code);
  switch (code) {
    case 'not_found':
      return { status: 404, code, message };
    case 'not_allowed':
    case 'has_account':
    case 'no_account':
      return { status: 409, code, message };
    case 'invalid_input':
      return { status: 422, code, message };
    default:
      return { status: 403, code: code === 'mfa_required' ? code : 'forbidden', message };
  }
})(securityDeps);
