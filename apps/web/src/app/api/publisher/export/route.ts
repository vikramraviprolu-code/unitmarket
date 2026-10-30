// PUB-E1: the publisher fetches its statement or its sales as CSV text. The publisher is the one in the
// session: the query has one field, the kind of file, and `.strict()` refuses any other (no publisher id can
// come from the client). This is an ordinary withRoute JSON answer: { filename, csv, truncated }. The page
// turns it into a file download in the browser. The text is built by the engine from the same read models as
// the pages: no buyer, last 6 of the order refs, cells that start with = + - @ made safe, at most 5000 rows.
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

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (await app()).engine.publisherExport({ actor, kind: input.kind });
  if (r === null)
    return { status: 404, code: 'not_found', message: 'We could not find that file.' };
  return { status: 200, body: r };
})(securityDeps);
