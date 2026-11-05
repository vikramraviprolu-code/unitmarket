import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import {
  ExposureInput,
  NOT_FOUND,
  REASON_REQUIRED,
  reasonCode,
  resolveGroup,
} from '../../../../../../lib/controls-input';

// INT-CTL: turn one exposure ON. Needs the authenticator code (the wrapper answers 403 mfa_required without it).
export const routeMeta: RouteMeta = {
  path: '/api/ops/api-exposure/[group]/on',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_exposure_on', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(routeMeta, ExposureInput, async ({ actor, input }) => {
  const group = resolveGroup(input.group);
  if (group === null) return NOT_FOUND;
  const code = reasonCode(input.reason_code);
  if (code === null) return REASON_REQUIRED;
  const r = await (
    await app()
  ).engine.setApiExposure({ actor, group, enabled: true, reason_code: code });
  if (r.ok) return { status: 200, body: { group, enabled: true } };
  if (r.error === 'mfa_required')
    return {
      status: 403,
      code: 'mfa_required',
      message: 'Turning this on needs your authenticator code.',
    };
  if (r.error === 'reason_required') return REASON_REQUIRED;
  return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
})(securityDeps);
