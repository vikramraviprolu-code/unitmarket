import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, createApiV1, securityDeps } from '../../../../../../server/access';
import { publicMandate } from '../../../../../../api-v1/mandate-view';

// INT-BUY / BUY.1: a signed-in buyer ends one of its own caps. The same domain call as DELETE /api/v1/mandates/{id}
// (revokeMandate), unchanged. The cap id comes from the path and the body is an empty {} (build note N1). Another
// buyer's cap and one that does not exist answer the same 404. Revoking twice is still 200 and keeps the first time.
export const routeMeta: RouteMeta = {
  path: '/api/buyer/mandates/[id]/revoke',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'buyer_mandate_revoke', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(
  routeMeta,
  z.object({ id: IdSchema }).strict(),
  async ({ actor, input }) => {
    if (actor.kind !== 'buyer')
      return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
    const r = await createApiV1(await app()).mandates.revoke(actor.buyer_id, input.id);
    return r.ok
      ? { status: 200, body: publicMandate(r.value) }
      : { status: 404, code: 'not_found', message: 'Not found.' };
  },
)(securityDeps);
