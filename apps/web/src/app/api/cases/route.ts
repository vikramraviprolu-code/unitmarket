import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/cases',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'case', per: 'actor', limit: 10, window_ms: 3_600_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'medium',
};

const Input = z
  .object({
    order_id: z.string().min(1).max(200).optional(),
    entitlement_id: z.string().min(1).max(200).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.openCase({
    actor,
    ...(input.order_id !== undefined ? { order_id: input.order_id } : {}),
    ...(input.entitlement_id !== undefined ? { entitlement_id: input.entitlement_id } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  if (r.ok) return { status: 201, body: r.value };
  return r.error.code === 'duplicate_open'
    ? {
        status: 409,
        code: 'duplicate_open',
        message: 'We already have a request open for this. We will update you there.',
      }
    : { status: 404, code: 'not_found', message: 'We could not find that item.' };
})(securityDeps);
