import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

// FIX-FLOW D1. Public on purpose: the actor kind does not matter (a buyer, a publisher and an operator
// all sign out here) and signing out with no live session is harmless. The Origin check (csrf) is the
// guard. It ends the one session of this cookie, never the persona's other sessions.
export const routeMeta: RouteMeta = {
  path: '/api/session/signout',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'signout', per: 'ip', limit: 30, window_ms: 60_000 },
  max_body_bytes: 64,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({}).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, session_id }) => {
  const r = await (await app()).engine.signOut({ actor, session_id });
  return { status: 200, body: { ok: true }, headers: { 'set-cookie': r.cookie } };
})(securityDeps);
