import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { currentSessionId } from '../../../../../server/session';

export const routeMeta: RouteMeta = {
  path: '/api/library/[id]/link',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'content', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 512,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({ id: z.string().min(1).max(200) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const session_id = await currentSessionId(actor);
  const r = await (
    await app()
  ).engine.issueLink({
    entitlement_id: input.id,
    actor,
    ...(session_id !== undefined ? { session_id } : {}),
  });
  if (r.ok) return { status: 200, body: { url: r.value.url, expires_at: r.value.expires_at } };
  switch (r.error.code) {
    case 'not_found':
      return { status: 404, code: 'not_found', message: 'We could not find that item.' };
    case 'window_ended':
      return {
        status: 403,
        code: 'window_ended',
        message: 'The access window for this item has ended.',
      };
    case 'not_available':
      return { status: 403, code: 'not_available', message: 'This item is not ready yet.' };
    default:
      return {
        status: 503,
        code: 'store_unavailable',
        message: 'The content is temporarily unavailable. You have not lost time.',
      };
  }
})(securityDeps);
