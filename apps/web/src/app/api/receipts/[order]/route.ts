import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/receipts/[order]',
  method: 'GET',
  auth: 'buyer',
  csrf: false,
  rate: { name: 'receipt', per: 'actor', limit: 60, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ order: z.string().min(1).max(200) }).strict();

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.buyerReceipt({ order_id: input.order, actor });
  return r === null
    ? { status: 404, code: 'not_found', message: 'We could not find that receipt.' }
    : { status: 200, body: r };
})(securityDeps);
