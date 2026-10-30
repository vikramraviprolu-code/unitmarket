import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { securityDeps } from '../../../server/access';
import { SKINS, skinSetCookie } from '../../../lib/skin';

// SKIN-A. Public: a visitor chooses a skin before signing in. The Origin check (csrf) is the guard, there
// is no session token to compare. The cookie holds the skin name and nothing else.
export const routeMeta: RouteMeta = {
  path: '/api/appearance',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'appearance', per: 'ip', limit: 30, window_ms: 60_000 },
  max_body_bytes: 64,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ skin: z.enum(SKINS) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ input }) => ({
  status: 200,
  body: { skin: input.skin },
  headers: { 'set-cookie': skinSetCookie(input.skin) },
}))(securityDeps);
