// INT-TR1 / TR1.5: the same pack as a printable page. withRoute does the session, the second factor, the
// rate limit and the headers; the page is attached afterwards to its 200 answer, as the content route does.
import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readUnitEvidence, renderEvidenceHtml } from '../../../../../../composition/ops-controls';
import { securityDeps } from '../../../../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/ops/units/[id]/evidence.html',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_unit_evidence_html', per: 'actor', limit: 30, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({ id: z.string().min(1).max(200) }).strict();

const pages = new Map<string, string>();
type Call = { params?: Promise<Record<string, string>> | Record<string, string> };

// Swaps withRoute's 200 answer for the page; every other answer passes through unchanged.
function withStream(guarded: (req: Request, call?: Call) => Promise<Response>) {
  return async (req: Request, call?: Call): Promise<Response> => {
    const res = await guarded(req, call);
    const id = res.headers.get('x-request-id');
    const page = id === null ? undefined : pages.get(id);
    if (id !== null) pages.delete(id);
    if (res.status !== 200 || page === undefined) return res;
    const headers = new Headers(res.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(page, { status: 200, headers });
  };
}

export const GET = withStream(
  withRoute(routeMeta, Input, async ({ actor, input, req_id }) => {
    if (actor.kind !== 'operator' || !actor.mfa)
      return {
        status: 403,
        code: 'mfa_required',
        message: 'The evidence pack needs the second factor.',
      };
    const p = await readUnitEvidence(input.id);
    if (p === null)
      return { status: 404, code: 'not_found', message: 'We could not find that unit.' };
    pages.set(req_id, await renderEvidenceHtml(p));
    return { status: 200, body: { ok: true } };
  })(securityDeps),
);
