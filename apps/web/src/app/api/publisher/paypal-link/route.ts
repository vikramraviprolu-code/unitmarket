import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { linkErrorText } from '../../../../lib/publisher-accounts-copy';

// POB-P1: the publisher links their own PayPal address (D-089 item 1: UnitMarket never creates a PayPal account).
// Publisher session with a claimed account, CSRF. The publisher is the one in the session; the body is the email
// only and `.strict()` refuses any extra field. The address is stored as requested and nothing uses it until an
// operator checks it (POST /api/ops/publishers/paypal-link-decisions). A change returns it to requested. The
// answer never echoes the address.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/paypal-link',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'publisher_paypal_link', per: 'actor', limit: 5, window_ms: 86_400_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ email: z.string().min(1).max(320) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.publisherAccounts.requestLink({ actor, email: input.email });
  if (r.ok) return { status: 200, body: { state: r.value.state } };
  const code = r.error.code;
  const message = linkErrorText(code);
  switch (code) {
    case 'invalid_email':
      return { status: 422, code, message };
    case 'same_as_current':
      return { status: 409, code, message };
    case 'no_account':
      return { status: 403, code, message };
    default:
      return { status: 403, code: 'forbidden', message: linkErrorText('forbidden') };
  }
})(securityDeps);
