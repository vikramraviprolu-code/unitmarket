import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

// API-B: the operator switch for agent purchases (`agent_buy_enabled`, off by default). An operator session
// that signed in WITH the authenticator code, a CSRF token and a reason. The wrapper answers 403 mfa_required
// to an operator without the code, for either direction: the no-code way to turn agent buying off is the
// stop button (POST /api/ops/stop), which turns it off together with PayPal. No API key of any scope reaches
// this route (auth `operator` is a session). It touches this one switch only.
export const routeMeta: RouteMeta = {
  path: '/api/ops/agent-buy',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_agent_buy', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ on: z.boolean(), reason: z.string().trim().min(1).max(200) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.setAgentBuy({ actor, on: input.on, reason: input.reason });
  if (r.ok) return { status: 200, body: { agent_buy_on: input.on } };
  if (r.error === 'operator_required')
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  if (r.error === 'mfa_required')
    return {
      status: 403,
      code: 'mfa_required',
      message:
        'Turning agent buying on needs your authenticator code. Sign in with it and try again.',
    };
  return { status: 422, code: 'reason_required', message: 'Please say why you are changing this.' };
})(securityDeps);
