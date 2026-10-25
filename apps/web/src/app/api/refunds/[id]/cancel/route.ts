import { z } from 'zod';
import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { cancelRefusal } from '../../../../../server/refund';

// CO-8 (CO-4 review): an operator with the second factor withdraws a refund request that is still
// `requested`. It needs no refunds switch, so a request can be cleared while refunds are paused. Any
// other state answers 409 wrong_state. Withdrawing twice is harmless (the second is wrong_state), so no
// Idempotency-Key is needed.
export const routeMeta: RouteMeta = {
  path: '/api/refunds/[id]/cancel',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'refund-cancel', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ id: IdSchema }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.refund.cancel({ actor, refund_request_id: input.id });
  if (r.ok) return { status: 200, body: r.value };
  const x = cancelRefusal(r.error.code);
  return { status: x.http, code: x.code, message: x.message };
})(securityDeps);
