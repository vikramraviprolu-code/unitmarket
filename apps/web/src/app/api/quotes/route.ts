import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { buyerDisplay } from '../../../server/buyer-display';

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

// One body type for every 200 answer: the quote, a no-match, or a quote with its display lines.
const reply = (body: object) => ({ status: 200 as const, body });

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const a = await app();
  const r = await a.engine.quote({
    offer: { publisher_slug: input.publisher, offer_code: input.offer },
    actor,
    source: 'direct',
    ...(input.option !== undefined ? { option: input.option } : {}),
    ...(input.ceiling_minor !== undefined ? { ceiling_minor: input.ceiling_minor } : {}),
    ...(input.proposed_minor !== undefined ? { proposed_minor: input.proposed_minor } : {}),
  });
  if (r.ok) {
    // GATEFIX2 item 3: an open unpaid order is named, with a way to its order page.
    if (r.value.kind === 'no_match' && r.value.reason === 'unpaid_order') {
      const order_ref = await a.engine.unpaidOrderRef({
        publisher: input.publisher,
        offer: input.offer,
        actor,
      });
      return reply(order_ref === null ? r.value : { ...r.value, order_ref });
    }
    // MC2-L5: a quote in another currency than the buyer's gets the display lines. The quote itself is the
    // seller's and is not touched; a buyer who sees no conversion gets no extra field.
    if (r.value.kind === 'quote') {
      const d = await buyerDisplay(a.engine, actor, { currencies: [r.value.price.currency] });
      const display = d.view(r.value.price);
      return reply(display.binding === null ? r.value : { ...r.value, display });
    }
    return reply(r.value);
  }
  return r.error.code === 'unknown_offer'
    ? { status: 404, code: 'not_found', message: 'That offer does not exist.' }
    : {
        status: 422,
        code: 'invalid_input',
        message: 'Check the amount and option and try again.',
      };
})(securityDeps);
