import { z } from 'zod';
import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { answerFor } from '../../../server/refund';

// CO-8 (P9): the operator refund. An operator session WITH the second factor (the wrapper answers 403
// mfa_required to any other operator, and the facade checks it again), CSRF, and an Idempotency-Key:
// a replay returns the stored answer and makes no second request. No `fail_safe_without_mfa`: this is
// the opposite of the stop button. The amount is named by the caller (a whole number of minor units, or
// null for "the rest"), checked against what is left by requestRefund, and sent by executeRefund; the
// route moves no money itself and the payments gates (switch, MFA, one open request per unit,
// remaining amount, PayPal's own remaining amount) all apply. A reason is required (it is sent to the
// buyer in PayPal's note and kept in the audit log).
export const routeMeta: RouteMeta = {
  path: '/api/refunds',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'refund', per: 'actor', limit: 120, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'high',
};

// amount_minor has no default: omitting it is an error, so a refund is never "the rest" by accident.
const Input = z
  .object({
    unit_id: IdSchema,
    amount_minor: z.number().int().safe().positive().max(100_000_000).nullable(),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) =>
  answerFor(await (await app()).engine.refund.request({ actor, ...input })),
)(securityDeps);
