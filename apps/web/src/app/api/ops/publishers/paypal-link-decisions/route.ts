import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { linkDecisionErrorText } from '../../../../../lib/publisher-accounts-copy';

// POB-P1: an operator with the second factor marks a publisher's PayPal address as checked, after typing it
// again in full (the retype pattern of the payee decision). A publisher session can never verify, not even its
// own address. The answer carries the new state only; the address is never echoed and the audit row holds the
// masked form.
export const routeMeta: RouteMeta = {
  path: '/api/ops/publishers/paypal-link-decisions',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'publisher_paypal_link_decision', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    publisher_id: z.string().min(1).max(100),
    email_retyped: z.string().min(1).max(320),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsPublisherAccess.decideLink({ actor, ...input });
  if (r.ok) return { status: 200, body: { state: r.value.state } };
  const code = r.error.code;
  const message = linkDecisionErrorText(code);
  switch (code) {
    case 'not_found':
      return { status: 404, code, message };
    case 'email_mismatch':
    case 'already_verified':
    case 'email_in_use':
      return { status: 409, code, message };
    case 'invalid_input':
      return { status: 422, code, message };
    default:
      return { status: 403, code: code === 'mfa_required' ? code : 'forbidden', message };
  }
})(securityDeps);
