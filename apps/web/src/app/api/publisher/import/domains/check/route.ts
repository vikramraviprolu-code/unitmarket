import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../../lib/web-import-copy';

// POB-I1 (D-089, J7): the publisher asks us to look for the code on its site. One guarded GET of each of two
// fixed paths on that host, nothing else. The body has the host and nothing else.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/domains/check',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'import_domain_check', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ host: z.string().min(1).max(300) }).strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.webImport.checkDomain({ actor, host: input.host });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: r.value };
})(securityDeps);
