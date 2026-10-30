import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { offerErrorText } from '../../../../../lib/offer-copy';

// PUB-B: a publisher changes the price or the offered options of its own offer. The result is a NEW
// offer version with its own authorisation row; nothing is updated in place, and a buyer who already
// approved keeps the price they saw. The publisher is the one in the session: the body has no publisher
// id, no currency, no status and no article, and `.strict()` refuses any extra field (mass assignment),
// also inside an option. The price is checked against UMS_OFFER_MAX_MINOR in the domain.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/offers/revise',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'offer_write', per: 'actor', limit: 20, window_ms: 60_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    offer_id: z.string().min(1).max(200),
    expected_version: z.string().min(1).max(20),
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
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.offers.revise({ actor, ...input });
  if (r.ok) return { status: 200, body: { offer_id: r.value.offer_id, version: r.value.version } };
  return {
    status: statusOf(r.error.code),
    code: r.error.code === 'not_publisher' ? 'forbidden' : r.error.code,
    message: offerErrorText(r.error.code === 'not_publisher' ? 'forbidden' : r.error.code),
  };
})(securityDeps);

function statusOf(code: string): 403 | 404 | 409 | 422 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
    case 'withdrawn':
    case 'not_live':
      return 409;
    case 'invalid_price':
    case 'invalid_options':
    case 'attestation_required':
    case 'invalid_reason':
      return 422;
    default:
      return 403;
  }
}
