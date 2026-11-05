import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import {
  NOT_FOUND,
  REASON_REQUIRED,
  SwitchInput,
  reasonCode,
  resolveSwitch,
} from '../../../../../../lib/controls-input';

// INT-CTL: turn one switch OFF. Fail-safe: an operator session without the authenticator code may do this,
// because closing only reduces what the system may do. It cannot turn anything on.
export const routeMeta: RouteMeta = {
  path: '/api/ops/switches/[name]/off',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_switch_off', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
  fail_safe_without_mfa: true,
};

export const POST = withRoute(routeMeta, SwitchInput, async ({ actor, input }) => {
  const name = resolveSwitch(input.name);
  if (name === null) return NOT_FOUND;
  const code = reasonCode(input.reason_code);
  if (code === null) return REASON_REQUIRED;
  const r = await (
    await app()
  ).engine.setFeatureSwitch({ actor, name, on: false, reason_code: code });
  if (r.ok) return { status: 200, body: { name, on: false } };
  if (r.error === 'mfa_required')
    return {
      status: 403,
      code: 'mfa_required',
      message: 'Turning this on needs your authenticator code.',
    };
  if (r.error === 'use_existing_control')
    return {
      status: 409,
      code: 'use_existing_control',
      message: 'This switch has its own control. Use that one.',
    };
  if (r.error === 'reason_required') return REASON_REQUIRED;
  return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
})(securityDeps);
