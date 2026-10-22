import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/quotes',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'quote', per: 'actor', limit: 30, window_ms: 60_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'low',
};

const Input = z
  .object({
    publisher: z.string().min(1).max(64),
    offer: z.string().min(1).max(64),
    option: z.enum(['keep_retrieve', 'online_read']).optional(),
    ceiling_minor: z.number().int().nonnegative().optional(),
    proposed_minor: z.number().int().nonnegative().optional(),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.quote({
    offer: { publisher_slug: input.publisher, offer_code: input.offer },
    actor,
    source: 'direct',
    ...(input.option !== undefined ? { option: input.option } : {}),
    ...(input.ceiling_minor !== undefined ? { ceiling_minor: input.ceiling_minor } : {}),
    ...(input.proposed_minor !== undefined ? { proposed_minor: input.proposed_minor } : {}),
  });
  if (r.ok) return { status: 200, body: r.value };
  return r.error.code === 'unknown_offer'
    ? { status: 404, code: 'not_found', message: 'That offer does not exist.' }
    : { status: 422, code: 'invalid_input', message: 'Check the amount and option and try again.' };
})(securityDeps);
