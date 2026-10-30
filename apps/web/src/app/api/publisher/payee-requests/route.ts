import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { requestErrorText } from '../../../../lib/payee-copy';

// PUB-A2: a publisher asks to be paid into another merchant id. This only stores a request; the payee
// changes only when an operator with the second factor verifies it (POST /api/ops/payee-decisions).
// The publisher is the one in the session: the body has no publisher id and `.strict()` refuses any
// extra field (mass assignment). The merchant id is never echoed back; the answer carries the request id.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/payee-requests',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'payee_request', per: 'actor', limit: 3, window_ms: 86_400_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    merchant_id: z.string().regex(/^[A-Z0-9]{13}$/),
    note: z.string().trim().min(1).max(200),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.payee.request({ actor, ...input });
  if (r.ok) return { status: 200, body: { request_id: r.value.request_id } };
  switch (r.error.code) {
    case 'same_as_current':
      return { status: 409, code: r.error.code, message: requestErrorText(r.error.code) };
    case 'invalid_merchant_id':
    case 'invalid_input':
      return { status: 422, code: r.error.code, message: requestErrorText(r.error.code) };
    default:
      return { status: 403, code: 'forbidden', message: requestErrorText('forbidden') };
  }
})(securityDeps);
