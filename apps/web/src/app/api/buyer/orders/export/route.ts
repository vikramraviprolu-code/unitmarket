import { TxnQueryMapSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { readSpendingExport } from '../../../../../composition/buyer';
import { searchRefusal } from '../../../../../api-v1/guard';
import { securityDeps } from '../../../../../server/access';

// INT-BUY / BUY.4: the buyer's own purchases under the current filter as CSV text in a JSON answer (the PUB-E1 shape
// { filename, csv, truncated }), for a signed-in buyer. It is SR1's buyer export read; the buyer comes from the
// session, so no id can come from the client, and a field a buyer may not use (buyer=) is 400 field_not_allowed.
export const routeMeta: RouteMeta = {
  path: '/api/buyer/orders/export',
  method: 'GET',
  auth: 'buyer',
  csrf: false,
  rate: { name: 'buyer_export', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, input }): Promise<HttpResult<unknown>> => {
  if (actor.kind !== 'buyer')
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  try {
    return { status: 200, body: await readSpendingExport(actor.buyer_id, input) };
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
})(securityDeps);
