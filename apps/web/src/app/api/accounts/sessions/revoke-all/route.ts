import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';

// ID-ACCOUNTS: "Sign out on all devices". Ends every session of the signed in account buyer, this one too,
// and clears the cookie. A test persona is shared by many people, so it has no such control (403).
export const routeMeta: RouteMeta = {
  path: '/api/accounts/sessions/revoke-all',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'account-revoke', per: 'actor', limit: 10, window_ms: 3_600_000 },
  max_body_bytes: 256,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({}).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor }) => {
  const r = await (await app()).engine.accounts.signOutEverywhere({ actor });
  if (r === null)
    return {
      status: 403,
      code: 'forbidden',
      message: 'This sign in has no account to sign out of.',
    };
  return { status: 200, body: { ok: true }, headers: { 'set-cookie': r.cookie } };
})(securityDeps);
