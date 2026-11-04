import {
  WebhookSubscriptionCreateSchema,
  WebhookSubscriptionCreatedSchema,
  WebhookSubscriptionViewSchema,
  pageOf,
} from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, createApiV1, securityDeps } from '../../../../server/access';

// API-C (E1): make and list your webhook subscriptions, with a bearer key holding events:read. A
// subscription can only name events your owner kind may receive (a buyer: orders, entitlements, refunds,
// mandates; a seller: sales and refunds). The signing secret is in the first answer only; the stored and
// replayed answer is the view without it, and no list or read shows it. An operator key is refused on every
// change by the key wrapper (mfa_required), so an operator subscription is made through the service only.
export const routeMetaGET: RouteMeta = {
  path: '/api/v1/webhook-subscriptions',
  method: 'GET',
  auth: 'apikey',
  scopes: ['events:read'],
  csrf: false,
  rate: { name: 'webhook_sub_read', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const routeMetaPOST: RouteMeta = {
  path: '/api/v1/webhook-subscriptions',
  method: 'POST',
  auth: 'apikey',
  scopes: ['events:read'],
  csrf: false,
  rate: { name: 'webhook_sub_create', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'medium',
};

export const GET = withRoute(routeMetaGET, z.object({}).strict(), async ({ actor }) => {
  const r = await createApiV1(await app()).webhooks.list(actor);
  if (!r.ok) return { status: 404, code: 'not_found', message: 'Not found.' };
  return { status: 200, body: pageOf(WebhookSubscriptionViewSchema).parse(r.value) };
})(securityDeps);

export const POST = withRoute(
  routeMetaPOST,
  WebhookSubscriptionCreateSchema,
  async ({ actor, input }) => {
    const r = await createApiV1(await app()).webhooks.create(actor, input);
    if (!r.ok) {
      return r.error.code === 'event_type_not_allowed'
        ? {
            status: 403,
            code: 'event_type_not_allowed',
            message: 'This account cannot subscribe to one of those events.',
          }
        : {
            status: 422,
            code: 'invalid_input',
            message: 'The request did not match the expected shape.',
          };
    }
    const body = WebhookSubscriptionCreatedSchema.parse(r.value);
    const { signing_secret, ...view } = body;
    void signing_secret;
    return { status: 201, body, replay_body: view };
  },
)(securityDeps);
