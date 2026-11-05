import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

// BR-2: the operator adds one business-rule setting (refund window, access window, mandate length) for the
// platform, a category, a seller or a buyer. An operator session that signed in WITH the authenticator code, a
// CSRF token and an Idempotency-Key. The rows are appended and never changed; the domain checks the second
// factor, the registry range, the scope id and the platform ceiling again, so a bypassed route still cannot
// write. No API key reaches this route (auth `operator` is a session). Nothing reads the rows yet (BR-3, BR-4).
export const routeMeta: RouteMeta = {
  path: '/api/ops/rules',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_rules', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 2048,
  idempotent: true,
  risk: 'high',
};

const Input = z
  .object({
    rule_key: z.string().min(1).max(100),
    scope_kind: z.string().min(1).max(20),
    scope_id: z.string().min(1).max(200).nullable(),
    value: z.number().int(),
    effective_from: z.iso.datetime(),
    effective_until: z.iso.datetime().nullable(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsRules.add({ actor, ...input });
  if (r.ok)
    return {
      status: 200,
      body: {
        id: r.value.id,
        rule_key: input.rule_key,
        scope_kind: input.scope_kind,
        scope_id: input.scope_id,
        value: input.value,
        effective_from: input.effective_from,
        effective_until: input.effective_until,
      },
    };
  switch (r.error.code) {
    case 'not_operator':
      return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
    case 'mfa_required':
      return {
        status: 403,
        code: 'mfa_required',
        message:
          'Changing a business rule needs your authenticator code. Sign in with it and try again.',
      };
    case 'backdated':
      return {
        status: 422,
        code: 'backdated',
        message: 'The start time is in the past. Choose now or a later time.',
      };
    case 'scope_unknown':
      return {
        status: 422,
        code: 'scope_unknown',
        message: 'There is no seller or buyer with that id.',
      };
    case 'above_platform_cap':
      return {
        status: 422,
        code: 'above_platform_cap',
        message: 'A buyer cannot be given a longer limit than the platform limit.',
      };
    case 'rule_invalid':
      return {
        status: 422,
        code: 'rule_invalid',
        message:
          'That setting is not allowed. Check the rule, who it applies to and that the value is inside its range.',
      };
  }
})(securityDeps);
