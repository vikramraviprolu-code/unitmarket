// BR-6: the operator downloads the business-rule history as CSV text. An ordinary withRoute JSON answer, like
// PUB-E1: { filename, csv, truncated }; the page turns it into a file in the browser. It reads rule_settings and
// nothing else, so it writes no journal row of its own (withRoute still writes its audit row). The query has no
// field: `.strict()` refuses any, so a caller cannot widen the read. At most 5000 rows (the BR-2 maximum);
// `truncated` is true when more are stored. Cells that start with = + - @ are made safe by the shared csvCell.
import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { securityDeps } from '../../../../../server/access';
import { readRulesExport } from '../../../../../composition/ops-rules';

export const routeMeta: RouteMeta = {
  path: '/api/ops/rules/export',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_rules_export', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({}).strict();

export const GET = withRoute(routeMeta, Input, async ({ actor }) => {
  const r = await readRulesExport(actor);
  if (r === null)
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  return { status: 200, body: r };
})(securityDeps);
