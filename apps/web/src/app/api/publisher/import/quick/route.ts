import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../lib/web-import-copy';

// POB-Q1: one address. The first call for a new site answers with the proof code and file (nothing is
// fetched). The page then sends the same address every few seconds: 'waiting' until the proof is up, then the
// site is verified and the import begun in the same call. Each check is one guarded GET of each of the two
// fixed proof paths of that host, so the rate limit allows a call every 5 seconds and no faster.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/quick',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'import_quick', per: 'actor', limit: 12, window_ms: 60_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ source_url: z.string().min(1).max(2048) }).strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.webImport.quick({
    actor,
    source_url: input.source_url,
  });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: r.value };
})(securityDeps);
