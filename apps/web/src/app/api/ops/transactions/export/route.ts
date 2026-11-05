import { TxnQueryMapSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { opsExportFor } from '../../../../../api-v1/ops';
import { app, securityDeps } from '../../../../../server/access';

// INT-SR1 (SR1.5): the operator list as CSV text in a JSON answer. Identity columns only with MFA.
export const routeMeta: RouteMeta = {
  path: '/api/ops/transactions/export',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_transactions_export', per: 'actor', limit: 10, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, input }) =>
  opsExportFor(await app(), actor, input),
)(securityDeps);
