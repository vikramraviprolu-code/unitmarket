import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { createErrorText } from '../../../../../lib/publisher-e1-copy';

// PUB-E1: a publisher puts one of its own articles on sale. The result is version 1 of a new offer with
// its own authorisation row. The publisher is the one in the session: the body has the article, the
// options with their prices and the tick, and nothing else; no publisher id, no status, no terms, no rights.
// OFFER-CUR: the one optional extra is `currency` (USD, EUR or GBP), the seller's choice; the domain checks that an
// enabled corridor covers it for the publisher's country, and without it the default is USD, then EUR, then GBP. `.strict()` refuses any extra field, also inside an option. The price is checked against
// UMS_OFFER_MAX_MINOR in the domain, and the article must be the session publisher's own.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/offers/create',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'offer_create', per: 'actor', limit: 20, window_ms: 60_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    article_id: z.string().min(1).max(200),
    options: z
      .array(
        z
          .object({
            option: z.enum(['keep_retrieve', 'online_read']),
            price_minor: z.number(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    attestation: z.literal(true),
    currency: z.enum(['USD', 'EUR', 'GBP']).optional(),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.offers.create({ actor, ...input });
  if (r.ok) return { status: 200, body: { offer_id: r.value.offer_id, version: r.value.version } };
  const code = r.error.code === 'not_publisher' ? 'forbidden' : r.error.code;
  return { status: statusOf(r.error.code), code, message: createErrorText(code) };
})(securityDeps);

function statusOf(code: string): 403 | 404 | 409 | 422 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
    case 'already_offered':
      return 409;
    case 'invalid_price':
    case 'invalid_options':
    case 'attestation_required':
    case 'no_corridor':
      return 422;
    default:
      return 403;
  }
}
