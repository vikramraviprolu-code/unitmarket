import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { passwordReasonText, signupErrorText } from '../../../lib/account-copy';

// ID-ACCOUNTS: buyer signup. Public: anyone may make an account, so the checks are the Origin test (CSRF), a
// strict small body, 20 requests an hour per address here (refused ones too) and 5 signups an hour per hashed
// address in the engine. An unknown client address answers busy and spends nothing. A filled honeypot gets
// the shape of a success and nothing is stored. A taken name answers 409, the one place a name's existence
// shows, and that costs a signup token. The answer carries a CSRF token and no internal id; the session cookie
// is new, and the browser's old session, if it sent one, is ended. No password is logged or audited.
export const routeMeta: RouteMeta = {
  path: '/api/accounts',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'account-request', per: 'ip', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    display_name: z.string().min(1).max(200),
    username: z.string().min(1).max(60),
    country: z.string().min(1).max(10),
    password: z.string().min(1).max(1024),
    accept_terms: z.literal(true),
    // The honeypot, under an opaque name so a browser does not autofill it.
    extra_k7q: z.string().max(200).optional(),
  })
  .strict();

export const POST = withRoute(
  routeMeta,
  Input,
  async ({ input, actor, session_id, ip_hash, ip_known }) => {
    const r = await (
      await app()
    ).engine.accounts.signUp({
      display_name: input.display_name,
      username: input.username,
      country: input.country,
      password: input.password,
      trap: input.extra_k7q ?? '',
      ip_hash,
      ip_known,
      previous: session_id !== null && actor.kind !== 'system' ? { id: session_id, actor } : null,
    });
    if (r.ok)
      return {
        status: 200,
        body: { csrf_token: r.csrf_token, actor_kind: 'buyer' },
        ...(r.cookie === null ? {} : { headers: { 'set-cookie': r.cookie } }),
      };
    switch (r.code) {
      case 'busy':
        return { status: 503, code: 'busy', message: signupErrorText('busy') };
      case 'rate_limited':
        return { status: 429, code: 'rate_limited', message: signupErrorText('rate_limited') };
      case 'taken':
        return { status: 409, code: 'taken', message: signupErrorText('taken') };
      case 'weak_password':
        return { status: 422, code: 'weak_password', message: passwordReasonText(r.reason) };
      default:
        return { status: 422, code: 'invalid_input', message: signupErrorText('invalid_input') };
    }
  },
)(securityDeps);
