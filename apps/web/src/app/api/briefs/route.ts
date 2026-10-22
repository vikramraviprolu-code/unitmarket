import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/briefs',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'discovery', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({ need: z.string().min(1).max(2000) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const a = await app();
  // READINESS: the agent path refuses when ai_enabled is off.
  if (!(await a.engine.aiEnabled()))
    return {
      status: 503,
      code: 'ai_off',
      message: 'Finding articles for a need is paused. You can still open an article link.',
    };
  const r = await a.engine.parseNeed({ actor, text: input.need });
  if (r.ok) return { status: 200, body: r.value };
  return r.error.code === 'too_long'
    ? { status: 422, code: 'too_long', message: 'Please shorten your need to 2000 characters.' }
    : {
        status: 422,
        code: 'unparseable',
        message: 'We could not read that need. Try fewer words.',
      };
})(securityDeps);
