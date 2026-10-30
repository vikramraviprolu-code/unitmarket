// PUB-E1: the publisher downloads its statement or its sales as CSV. The publisher is the one in the
// session: the query has one field, the kind of file, and `.strict()` refuses any other (no publisher id can
// come from the client). withRoute does the authorisation, the rate limit and the security headers; the CSV
// text is attached to its 200 answer afterwards, the way the content route attaches its stream. The text is
// built by the engine from the same read models as the pages: no buyer, last 6 of the order refs, cells that
// start with = + - @ made safe.
import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';

export const routeMeta: RouteMeta = {
  path: '/api/publisher/export',
  method: 'GET',
  auth: 'publisher',
  csrf: false,
  rate: { name: 'publisher_export', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ kind: z.enum(['statement', 'sales']) }).strict();

type Served = { filename: string; csv: string };
const served = new Map<string, Served>();

type Call = { params?: Promise<Record<string, string>> | Record<string, string> };

// Attaches the file to withRoute's 200 answer; every other answer passes through unchanged.
function withStream(guarded: (req: Request, call?: Call) => Promise<Response>) {
  return async (req: Request, call?: Call): Promise<Response> => {
    const res = await guarded(req, call);
    const id = res.headers.get('x-request-id');
    const plan = id === null ? undefined : served.get(id);
    if (id !== null) served.delete(id);
    if (res.status !== 200 || plan === undefined) return res;
    const headers = new Headers(res.headers);
    headers.set('content-type', 'text/csv; charset=utf-8');
    headers.set('content-disposition', `attachment; filename="${plan.filename}"`);
    headers.set('cache-control', 'private, no-store');
    return new Response(plan.csv, { status: 200, headers });
  };
}

export const GET = withStream(
  withRoute(routeMeta, Input, async ({ actor, input, req_id }) => {
    const r = await (await app()).engine.publisherExport({ actor, kind: input.kind });
    if (r === null)
      return { status: 404, code: 'not_found', message: 'We could not find that file.' };
    served.set(req_id, r);
    return { status: 200, body: { ok: true } };
  })(securityDeps),
);
