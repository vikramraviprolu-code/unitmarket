import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../../lib/web-import-copy';

// DOMAIN-PROOF-2 (D-116): an operator marks one pending web address of a publisher as verified. An operator session WITH the second factor
// (the wrapper answers 403 mfa_required to any other operator), CSRF, a reason. Only the address id and the reason
// are read. The audit row carries the operator and the reason; no code is read or written.
export const routeMeta: RouteMeta = {
  path: '/api/ops/publishers/domains/vouch',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_domain_vouch', per: 'actor', limit: 30, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    domain_id: z.string().min(1).max(100),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.opsDomains.vouch({ actor, ...input });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: r.value };
})(securityDeps);
