import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { opsErrorText } from '../../../../lib/payee-copy';

// PUB-A2: an operator verifies or rejects one payee change request. An operator session WITH the
// second factor (the wrapper answers 403 mfa_required to any other operator; there is no
// `fail_safe_without_mfa`: this can move where money goes), CSRF, a reason, and for a verify the
// whole merchant id typed again. A publisher session is refused by the wrapper (wrong role). On the
// hosted sandbox app a verify answers 409 owner_command_required and changes nothing (D-062).
export const routeMeta: RouteMeta = {
  path: '/api/ops/payee-decisions',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'payee_decision', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

// merchant_id_retyped is empty for a reject; a verify compares it with the stored request, exactly.
const Input = z
  .object({
    request_id: z.string().min(1).max(100),
    merchant_id_retyped: z.string().max(40),
    decision: z.enum(['verified', 'rejected']),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.payee.decide({ actor, ...input });
  if (r.ok) return { status: 200, body: { decision: r.value.decision } };
  const code = r.error.code;
  const message = opsErrorText(code);
  switch (code) {
    case 'not_found':
      return { status: 404, code, message };
    case 'already_decided':
    case 'merchant_in_use':
    case 'owner_command_required':
      return { status: 409, code, message };
    case 'id_mismatch':
    case 'invalid_input':
      return { status: 422, code, message };
    default:
      return { status: 403, code: code === 'mfa_required' ? code : 'forbidden', message };
  }
})(securityDeps);
