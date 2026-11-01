import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { ACCOUNT_WRONG_CURRENT, passwordReasonText } from '../../../../lib/account-copy';

// ID-ACCOUNTS: change the password of the signed in buyer. The account is the session's; the body names no
// account and a field that tries to is refused (strict). The current password is checked first and a wrong
// one counts towards the lock. A good change ends every other session of the buyer and keeps this one.
export const routeMeta: RouteMeta = {
  path: '/api/accounts/password',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'account-password', per: 'actor', limit: 5, window_ms: 900_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    current_password: z.string().min(1).max(1024),
    new_password: z.string().min(1).max(1024),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ input, actor, session_id }) => {
  const r = await (
    await app()
  ).engine.accounts.changePassword({
    actor,
    session_id,
    current_password: input.current_password,
    new_password: input.new_password,
  });
  if (r.ok) return { status: 200, body: { ok: true } };
  switch (r.code) {
    case 'no_account':
      return {
        status: 403,
        code: 'forbidden',
        message: 'This sign in has no password to change.',
      };
    case 'wrong_password':
      return { status: 401, code: 'wrong_password', message: ACCOUNT_WRONG_CURRENT };
    default:
      return { status: 422, code: 'weak_password', message: passwordReasonText(r.reason) };
  }
})(securityDeps);
