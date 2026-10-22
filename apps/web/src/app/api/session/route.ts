import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/session',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'passcode', per: 'ip', limit: 5, window_ms: 900_000 },
  rate_target: 'persona',
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({ persona: z.string().min(1).max(40), passcode: z.string().min(1).max(200) })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ input }) => {
  const s = await (await app()).engine.signIn(input);
  // One answer for a wrong passcode and an unknown persona.
  if (s === null)
    return { status: 401, code: 'sign_in_failed', message: 'That passcode did not work.' };
  return {
    status: 200,
    body: { csrf_token: s.csrf_token, actor_kind: s.actor.kind },
    headers: { 'set-cookie': s.cookie },
  };
})(securityDeps);
