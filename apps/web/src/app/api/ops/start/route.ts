import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { startRefusalText, switchNowText } from '../../../../lib/ops-copy';

// WEB-OPS-START (ENH-2): the "Start PayPal" button. An operator session that signed in WITH the
// authenticator code (there is no `fail_safe_without_mfa`: starting widens what the system may do, so
// the wrapper answers 403 mfa_required to an operator without the code), a CSRF token, a reason and
// the scope typed back. It turns the paypal_outbound switch ON and nothing else, and only while an
// active approval row covers it: the same check as `pnpm safety:resume` (resumeOutbound). It cannot
// insert an approval and cannot set UMS_PAYPAL_CONNECT; until that Cloud Run flag is on, no PayPal
// call leaves, and the answer says which way the flag stands.
export const routeMeta: RouteMeta = {
  path: '/api/ops/start',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_start', per: 'actor', limit: 5, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    reason: z.string().trim().min(3).max(200),
    // Typed by the operator; the engine compares it with the scope of the active approval row.
    confirm_scope: z.string().max(100),
  })
  .strict();

// The codes after which the person cannot tell what the switch is: the answer adds the stored state,
// read back now, so the page does not have to guess.
const UNSURE = new Set(['switch_locked', 'switch_changed']);

export const POST = withRoute(routeMeta, Input, async ({ actor, input, log }) => {
  const engine = (await app()).engine;
  let r: Awaited<ReturnType<typeof engine.startOutbound>>;
  try {
    r = await engine.startOutbound({ actor, ...input });
  } catch (e) {
    // An unexpected error: the start may or may not have happened. Log the error name only, read the
    // switch back and say so; never the error text.
    log.log({
      msg: 'ops_start_error',
      level: 'error',
      fields: { err_name: e instanceof Error ? e.name : 'unknown' },
    });
    const on = await engine.outboundSwitchOn(actor);
    // HttpResult has no 500 member (a thrown error becomes the generic 500 in withRoute); this answer
    // keeps the same envelope but names what the person must do, so it is typed through the 503 shape.
    return {
      status: 500 as unknown as 503,
      code: 'start_unknown',
      message: `${startRefusalText('start_unknown')} ${switchNowText(on)}`,
    };
  }
  if (r.ok) return { status: 200, body: r.value };
  const code = r.error;
  const message = UNSURE.has(code)
    ? `${startRefusalText(code)} ${switchNowText(await engine.outboundSwitchOn(actor))}`
    : startRefusalText(code);
  if (code === 'operator_required') return { status: 403, code: 'mfa_required', message };
  if (code === 'reason_required') return { status: 422, code, message };
  return { status: 409, code, message };
})(securityDeps);
