import { z } from 'zod';
import { USERNAME_PATTERN, withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { BUYER_SIGNIN_FAILED } from '../../../../lib/account-copy';

// ID-ACCOUNTS: buyer sign in with a username and a password. Public, Origin checked, strict, small. 5 tries per
// 15 minutes for one address and one name (the bucket key hashes the name, as /api/session does for a persona);
// the name must already have the shape the bucket keys on, so letter case cannot make a second bucket. An
// unknown name, a wrong password and a locked account give one answer, 401, with one sentence. A new session
// is made on every sign in and the browser's old one is ended.
export const routeMeta: RouteMeta = {
  path: '/api/accounts/login',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'account-login', per: 'ip', limit: 5, window_ms: 900_000 },
  // One address spraying many names still meets a limit: 30 tries per 15 minutes across all names. Not charged
  // when no client address is known (one bucket for everyone would let one visitor starve all).
  rate_ip: { name: 'account-login-ip', per: 'ip', limit: 30, window_ms: 900_000 },
  rate_target: 'username',
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    username: z.string().regex(USERNAME_PATTERN),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ input, actor, session_id }) => {
  const s = await (
    await app()
  ).engine.accounts.signIn({
    username: input.username,
    password: input.password,
    previous: session_id !== null && actor.kind !== 'system' ? { id: session_id, actor } : null,
  });
  if (s === null) return { status: 401, code: 'sign_in_failed', message: BUYER_SIGNIN_FAILED };
  return {
    status: 200,
    body: { csrf_token: s.csrf_token, actor_kind: 'buyer' },
    headers: { 'set-cookie': s.cookie },
  };
})(securityDeps);
