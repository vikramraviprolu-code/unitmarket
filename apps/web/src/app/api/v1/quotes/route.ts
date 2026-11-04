import { QuoteRequestSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { createQuote } from '../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/quotes',
  method: 'POST',
  auth: 'apikey',
  scopes: ['orders:write'],
  csrf: false,
  rate: { name: 'v1_quote', per: 'actor', limit: 30, window_ms: 60000 },
  max_body_bytes: 2048,
  idempotent: true,
  risk: 'low',
};

export const POST = withRoute(routeMeta, QuoteRequestSchema, async ({ actor, principal, input }) =>
  createQuote(await app(), { actor, principal }, input),
)(securityDeps);
