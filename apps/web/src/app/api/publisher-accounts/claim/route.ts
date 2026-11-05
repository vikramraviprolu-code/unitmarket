import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { claimErrorText } from '../../../../lib/publisher-accounts-copy';

// POB-P1: a new publisher claims an account with the one time invite code an operator showed (D-089). Public:
// the checks are the Origin test (CSRF), a strict small body, 20 requests an hour per address here (refused ones
// too) and 10 claim tries per hashed address in 15 minutes in the engine. An unknown client address answers busy
// and spends nothing. A wrong, expired, used or voided code is one answer, 403 invalid_code; a taken username shows
// only to someone holding a valid code. Success makes the account and a publisher session; the browser's old
// session, if it sent one, is ended. No password or code is logged or audited.
export const routeMeta: RouteMeta = {
  path: '/api/publisher-accounts/claim',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'publisher-claim-request', per: 'ip', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    code: z.string().min(1).max(40),
    username: z.string().min(1).max(60),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const POST = withRoute(
  routeMeta,
  Input,
  async ({ input, actor, session_id, ip_hash, ip_known }) => {
    const r = await (
      await app()
    ).engine.publisherAccounts.claim({
      code: input.code,
      username: input.username,
      password: input.password,
      ip_hash,
      ip_known,
      previous: session_id !== null && actor.kind !== 'system' ? { id: session_id, actor } : null,
    });
    if (r.ok)
      return {
        status: 200,
        body: { csrf_token: r.csrf_token, actor_kind: 'publisher' },
        headers: { 'set-cookie': r.cookie },
      };
    switch (r.code) {
      case 'busy':
        return { status: 503, code: 'busy', message: claimErrorText('busy') };
      case 'rate_limited':
        return { status: 429, code: 'rate_limited', message: claimErrorText('rate_limited') };
      case 'taken':
        return { status: 409, code: 'taken', message: claimErrorText('taken') };
      case 'invalid_code':
        return { status: 403, code: 'invalid_code', message: claimErrorText('invalid_code') };
      case 'weak_password':
        return {
          status: 422,
          code: 'weak_password',
          message: claimErrorText('weak_password', r.reason),
        };
      default:
        return { status: 422, code: 'invalid_input', message: claimErrorText('invalid_input') };
    }
  },
)(securityDeps);
