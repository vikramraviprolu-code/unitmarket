import { z } from 'zod';
import { USERNAME_PATTERN, withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { ACCOUNT_SIGNIN_FAILED } from '../../../lib/publisher-accounts-copy';

export const routeMeta: RouteMeta = {
  path: '/api/session',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'passcode', per: 'ip', limit: 5, window_ms: 900_000 },
  rate_target: 'persona',
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'high',
};

// CO-6: `operator` and `code` are for the operator persona only (name and authenticator code); other
// personas ignore them. Wrong codes spend the same persona bucket as wrong passcodes.
// POB-P1: a publisher with a claimed account signs in with `username` and `password` instead of a persona and a
// passcode. The two shapes are exclusive: a body with fields of both is refused. The username path spends the one
// bucket of an address that has no persona (5 tries in 15 minutes), and the account lock counts wrong passwords.
const Input = z
  .object({
    persona: z.string().min(1).max(40).optional(),
    passcode: z.string().min(1).max(200).optional(),
    operator: z.string().max(40).optional(),
    code: z.string().max(16).optional(),
    username: z.string().regex(USERNAME_PATTERN).optional(),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .refine(
    (i) =>
      (i.persona !== undefined &&
        i.passcode !== undefined &&
        i.username === undefined &&
        i.password === undefined) ||
      (i.username !== undefined &&
        i.password !== undefined &&
        i.persona === undefined &&
        i.passcode === undefined &&
        i.operator === undefined &&
        i.code === undefined),
  );

export const POST = withRoute(routeMeta, Input, async ({ input, actor, session_id }) => {
  const e = (await app()).engine;
  if (input.username !== undefined && input.password !== undefined) {
    const a = await e.publisherAccounts.signIn({
      username: input.username,
      password: input.password,
      previous: session_id !== null && actor.kind !== 'system' ? { id: session_id, actor } : null,
    });
    if (a === null) return { status: 401, code: 'sign_in_failed', message: ACCOUNT_SIGNIN_FAILED };
    return {
      status: 200,
      body: { csrf_token: a.csrf_token, actor_kind: 'publisher' },
      headers: { 'set-cookie': a.cookie },
    };
  }
  const s = await e.signIn({
    persona: input.persona ?? '',
    passcode: input.passcode ?? '',
    ...(input.operator === undefined ? {} : { operator: input.operator }),
    ...(input.code === undefined ? {} : { code: input.code }),
  });
  // One answer for a wrong passcode and an unknown persona.
  if (s === null)
    return { status: 401, code: 'sign_in_failed', message: 'That passcode did not work.' };
  return {
    status: 200,
    body: {
      csrf_token: s.csrf_token,
      actor_kind: s.actor.kind,
      ...(s.actor.kind === 'operator' ? { mfa: s.actor.mfa } : {}),
    },
    headers: { 'set-cookie': s.cookie },
  };
})(securityDeps);
