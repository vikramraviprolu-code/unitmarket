import { WebhookSubscriptionViewSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, createApiV1, securityDeps } from '../../../../../server/access';

// API-C (E1): disable one of your webhook subscriptions. It receives nothing more; the row and its
// deliveries stay, so they stay readable. Another owner's subscription and a missing one answer the same
// 404. Disabling twice is still 200 and keeps the first time.
export const routeMeta: RouteMeta = {
  path: '/api/v1/webhook-subscriptions/[id]',
  method: 'DELETE',
  auth: 'apikey',
  scopes: ['events:read'],
  csrf: false,
  rate: { name: 'webhook_sub_remove', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'medium',
};

export const DELETE = withRoute(
  routeMeta,
  // Any text up to 200 characters: a malformed id is a plain not found, the same as a missing one.
  z.object({ id: z.string().max(200) }).strict(),
  async ({ actor, input }) => {
    const r = await createApiV1(await app()).webhooks.remove(actor, input.id);
    if (!r.ok) return { status: 404, code: 'not_found', message: 'Not found.' };
    return { status: 200, body: WebhookSubscriptionViewSchema.parse(r.value) };
  },
)(securityDeps);
