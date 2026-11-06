import { TxnQueryMapSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { transactions } from '../../../../../api-v1/ops';
import { app, securityDeps } from '../../../../../server/access';

// INT-SR1 (SR1.3): see src/api-v1/ops.ts. An operator key (ops:read): order refs, amounts, states, flags and
// opaque ids only. No buyer id or agent key id (C3, FIX-B4), no buyer or seller name and no PayPal id,
// whatever the key asks for.
export const routeMeta: RouteMeta = {
  path: '/api/v1/ops/transactions',
  method: 'GET',
  auth: 'apikey',
  scopes: ['ops:read'],
  csrf: false,
  rate: { name: 'v1_ops_transactions', per: 'actor', limit: 60, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, TxnQueryMapSchema, async ({ actor, principal, input }) =>
  transactions(await app(), { actor, principal }, input),
)(securityDeps);
