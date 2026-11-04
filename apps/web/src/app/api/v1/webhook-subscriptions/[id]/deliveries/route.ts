import { WebhookDeliveryViewSchema, pageOf } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, createApiV1, securityDeps } from '../../../../../../server/access';

// API-C (E2): the newest 100 deliveries of one of your webhook subscriptions: attempt, status, next try
// and an error code from a closed list. Never the receiver's answer, the body, the url or a secret.
// Another owner's subscription and a missing one answer the same 404.
export const routeMeta: RouteMeta = {
  path: '/api/v1/webhook-subscriptions/[id]/deliveries',
  method: 'GET',
  auth: 'apikey',
  scopes: ['events:read'],
  csrf: false,
  rate: { name: 'webhook_deliveries_read', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(
  routeMeta,
  z.object({ id: z.string().max(200) }).strict(),
  async ({ actor, input }) => {
    const r = await createApiV1(await app()).webhooks.deliveries(actor, input.id);
    if (!r.ok) return { status: 404, code: 'not_found', message: 'Not found.' };
    return { status: 200, body: pageOf(WebhookDeliveryViewSchema).parse(r.value) };
  },
)(securityDeps);
