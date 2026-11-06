import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

// POB-M1 (D-089): the operator sets the platform fee on top, 0 to 30 percent of the publisher's price, in basis points.
// An operator session that signed in WITH the authenticator code, a CSRF token and an Idempotency-Key. The rows are appended
// and never changed; the domain checks the second factor, the range and the reason again, so a bypassed route still cannot
// write. No API key reaches this route (auth `operator` is a session). A new rate applies to offers published after it; a
// price already listed and a sale already made keep the split they have.
export const routeMeta: RouteMeta = {
  path: '/api/ops/fee',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_fee', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

const Input = z
  .object({
    fee_bps: z.number().int(),
    reason: z.string().max(500),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.opsFee.set({ actor, fee_bps: input.fee_bps, reason: input.reason });
  if (r.ok) return { status: 200, body: { id: r.value.id, fee_bps: r.value.fee_bps } };
  switch (r.error.code) {
    case 'not_operator':
      return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
    case 'mfa_required':
      return {
        status: 403,
        code: 'mfa_required',
        message: 'Changing the fee needs your authenticator code. Sign in with it and try again.',
      };
    case 'fee_invalid':
      return {
        status: 422,
        code: 'fee_invalid',
        message: 'The fee must be from 0 to 30 percent.',
      };
    case 'reason_invalid':
      return {
        status: 422,
        code: 'reason_invalid',
        message: 'Give a reason of 3 to 200 characters.',
      };
    case 'conflict':
      return {
        status: 409,
        code: 'conflict',
        message: 'The fee was changed at the same moment. Check the fee shown and try again.',
      };
  }
})(securityDeps);
