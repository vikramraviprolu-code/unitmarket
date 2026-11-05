import { TxnQueryMapSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { exportSellerSales } from '../../../../../composition/seller';
import { securityDeps } from '../../../../../server/access';

// INT-SEL (SEL.2): the seller's own sales as CSV text in a JSON answer { filename, csv, truncated }. The seller is
// the one in the session. A filter the role may not use (buyer, agent_key, seller, environment, flags) gives
// 400 field_not_allowed. No buyer column, no order total, no reason text.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/sales/export',
  method: 'GET',
  auth: 'publisher',
  csrf: false,
  rate: { name: 'publisher_sales_export', per: 'actor', limit: 10, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, input }) => {
  const r = await exportSellerSales(actor, input as Record<string, string>);
  if (r.kind === 'ok')
    return { status: 200, body: { filename: r.filename, csv: r.csv, truncated: r.truncated } };
  if (r.kind === 'refused') return { status: r.status, code: r.code, message: r.message };
  return { status: 403, code: 'forbidden', message: 'This sign-in cannot export sales.' };
})(securityDeps);
