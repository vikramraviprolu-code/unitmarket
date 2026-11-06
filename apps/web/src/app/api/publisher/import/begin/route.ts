import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../lib/web-import-copy';

// POB-I1 (D-089, J7 and J8): the publisher begins an import. The proof of the domain is fetched again first;
// if it no longer holds the answer is 409 proof_lost and nothing is written or read. Otherwise one batch is
// queued and the job loop reads it in the background. The body has the address and nothing else.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/begin',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'import_begin', per: 'actor', limit: 6, window_ms: 3_600_000 },
  max_body_bytes: 2560,
  idempotent: false,
  risk: 'high',
};

const Input = z.object({ source_url: z.string().min(1).max(2048) }).strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.webImport.begin({ actor, source_url: input.source_url });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: { batch_id: r.value.batch_id } };
})(securityDeps);
