import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { applicantErrorText } from '../../../../../lib/ops-applicants-copy';

// PUB-E2: an operator adds an applicant (a publisher with status applied). Operator session WITH the second
// factor (the wrapper answers 403 mfa_required to any other operator), CSRF, a reason. A publisher or buyer
// session is refused by the wrapper. Only the four fields below are accepted: no status, no payee, no id.
// This is not signup: the applicant gets no sign in, no payee and no offers.
export const routeMeta: RouteMeta = {
  path: '/api/ops/publishers/applicants',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'publisher_applicant_add', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    slug: z.string().min(1).max(100),
    display_name: z.string().min(1).max(200),
    country: z.string().min(1).max(10),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsApplicants.add({ actor, ...input });
  if (r.ok) return { status: 200, body: { publisher_id: r.value.publisher_id } };
  const code = r.error.code;
  const message = applicantErrorText(code);
  switch (code) {
    case 'slug_taken':
    case 'not_allowed':
    case 'already_decided':
      return { status: 409, code, message };
    case 'not_found':
      return { status: 404, code, message };
    case 'invalid_input':
    case 'invalid_slug':
      return { status: 422, code, message };
    default:
      return { status: 403, code: code === 'mfa_required' ? code : 'forbidden', message };
  }
})(securityDeps);
