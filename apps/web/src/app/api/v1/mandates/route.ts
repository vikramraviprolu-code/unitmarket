import { MandateCreateRequestSchema, type Actor } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, createApiV1, securityDeps } from '../../../../server/access';
import { publicMandate } from '../../../../api-v1/mandate-view';

// API-B (G2): a buyer gives one of their own agent keys a spending cap. A buyer API client key with
// mandates:write only: an agent key can never create, widen or un-revoke its own cap (its scopes do not
// include mandates:write, and the principal is checked again here). The request carries the buyer's
// acceptance of the terms; a purchase inside the cap then needs no per-order token.
export const routeMeta: RouteMeta = {
  path: '/api/v1/mandates',
  method: 'POST',
  auth: 'apikey',
  scopes: ['mandates:write'],
  csrf: false,
  rate: { name: 'api_v1_mandate_create', per: 'actor', limit: 30, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'high',
};

const buyerOnly = (actor: Actor, kind: string | null): string | null =>
  actor.kind === 'buyer' && kind === 'api_client' ? actor.buyer_id : null;

export const POST = withRoute(
  routeMeta,
  MandateCreateRequestSchema,
  async ({ actor, principal, input }) => {
    const buyer_id = buyerOnly(actor, principal?.kind ?? null);
    if (buyer_id === null) {
      return {
        status: 403,
        code: 'forbidden',
        message: 'Only a buyer API key can set a spending cap.',
      };
    }
    const made = await createApiV1(await app()).mandates.create({
      buyer_id,
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
          message: 'This agent key already has an open cap. Revoke it first.',
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
  },
)(securityDeps);
