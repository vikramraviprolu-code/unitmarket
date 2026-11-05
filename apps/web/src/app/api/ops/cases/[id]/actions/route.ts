import { CaseActionBodySchema, IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import { caseActionErrorResult } from '../../../../../../lib/alerts-http';

// INT-AL AL.8: an operator acts on one case: diagnose, restore, credit, close not charged, offer a refund or
// close with no fault. An operator session WITH the second factor, CSRF and an Idempotency-Key. Offering a
// refund goes through the existing payments refund path; a case in a state that does not allow the action is
// 409 wrong_state.
export const routeMeta: RouteMeta = {
  path: '/api/ops/cases/[id]/actions',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_case_action', per: 'actor', limit: 600, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

const Input = CaseActionBodySchema.extend({ id: IdSchema }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.opsCases.act({
    actor,
    case_id: input.id,
    action: input.action,
    reason: input.reason,
    ...(input.credit_ms === undefined ? {} : { credit_ms: input.credit_ms }),
  });
  return r.ok ? { status: 200, body: r.value } : caseActionErrorResult(r.error.code);
})(securityDeps);
