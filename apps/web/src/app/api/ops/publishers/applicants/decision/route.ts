import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import { applicantErrorText } from '../../../../../../lib/ops-applicants-copy';

// PUB-E2: an operator approves (applied to active) or rejects (stays applied, a decision row) one applicant.
// Operator session WITH the second factor, CSRF, a reason of 3 to 200 characters. Only the publisher id,
// the decision and the reason are read. Orders, units, access, approvals and the ledger are not touched; the
// audit row carries the operator and the reason. An approved applicant still has no sign in.
export const routeMeta: RouteMeta = {
  path: '/api/ops/publishers/applicants/decision',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'publisher_applicant_decision', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    publisher_id: z.string().min(1).max(100),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsApplicants.decide({ actor, ...input });
  if (r.ok) return { status: 200, body: { state: r.value.state } };
  const code = r.error.code;
  const message = applicantErrorText(code);
  switch (code) {
    case 'not_found':
      return { status: 404, code, message };
    case 'not_allowed':
    case 'already_decided':
    case 'slug_taken':
      return { status: 409, code, message };
    case 'invalid_input':
    case 'invalid_slug':
      return { status: 422, code, message };
    default:
      return { status: 403, code: code === 'mfa_required' ? code : 'forbidden', message };
  }
})(securityDeps);
