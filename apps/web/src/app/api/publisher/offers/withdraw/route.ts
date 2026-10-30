import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { offerErrorText } from '../../../../../lib/offer-copy';

// PUB-B: a publisher takes its own offer off sale. The result is a new offer version with status
// withdrawn (and its own authorisation row); a new buyer gets no match, a buyer who already approved keeps
// what they saw. The publisher is the one in the session; `.strict()` refuses any extra field.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/offers/withdraw',
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
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.offers.withdraw({ actor, ...input });
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
