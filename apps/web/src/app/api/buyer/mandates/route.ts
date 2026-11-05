import { MandateCreateRequestSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, createApiV1, securityDeps } from '../../../../server/access';
import { publicMandate } from '../../../../api-v1/mandate-view';

// INT-BUY / BUY.1: a signed-in buyer gives one of its own agent keys a spending cap. The same domain call as
// POST /api/v1/mandates (createMandate), unchanged. D-101 amends D-093: a buyer may also do this from a session,
// because a signed-in buyer can already mint an api_client key with mandates:write and call the v1 route, so this
// adds no authority; it is a shorter path behind CSRF and an Idempotency-Key. An agent key holds no session and
// never reaches this route. The body is the contract's MandateCreateRequestSchema: its terms_accepted (literal
// true) is the confirm flag, so a body without it is 422 invalid_input.
export const routeMeta: RouteMeta = {
  path: '/api/buyer/mandates',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'buyer_mandate_create', per: 'actor', limit: 30, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(routeMeta, MandateCreateRequestSchema, async ({ actor, input }) => {
  if (actor.kind !== 'buyer')
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  const made = await createApiV1(await app()).mandates.create({
    buyer_id: actor.buyer_id,
    agent_key_id: input.agent_key_id,
    currency: input.currency,
    max_total_minor: input.max_total_minor ?? null,
    max_count: input.max_count ?? null,
    max_per_purchase_minor: input.max_per_purchase_minor ?? null,
    expires_at: input.expires_at,
  });
  if (made.ok) return { status: 201, body: publicMandate(made.value) };
  switch (made.error) {
    case 'unknown_agent_key':
      return { status: 404, code: 'not_found', message: 'Not found.' };
    case 'mandate_active':
      return {
        status: 409,
        code: 'mandate_active',
        message: 'This agent key already has an open cap. End it first.',
      };
    case 'invalid_expiry':
      return {
        status: 422,
        code: 'invalid_expiry',
        message: 'The expiry must be in the future and within 90 days.',
      };
    default:
      return {
        status: 422,
        code: 'invalid_input',
        message: 'The request did not match the expected shape.',
      };
  }
})(securityDeps);
