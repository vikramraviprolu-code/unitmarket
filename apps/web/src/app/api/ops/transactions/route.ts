import { TxnQueryMapSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { opsTransactionsFor } from '../../../../api-v1/ops';
import { app, securityDeps } from '../../../../server/access';

// INT-SR1 (SR1.3): the operator list for a signed-in operator. Names and PayPal ids appear only when the
// session has MFA (src/server/ops-identity.ts); a session without it gets the key route's answer.
export const routeMeta: RouteMeta = {
  path: '/api/ops/transactions',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_transactions', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, input }) =>
  opsTransactionsFor(await app(), actor, input),
)(securityDeps);
