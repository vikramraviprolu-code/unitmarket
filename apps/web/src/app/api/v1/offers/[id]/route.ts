import { OfferIdParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { getOffer } from '../../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/offers/[id]',
  method: 'GET',
  auth: 'apikey',
  scopes: ['catalogue:read'],
  csrf: false,
  rate: { name: 'v1_offer', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, OfferIdParamSchema, async ({ actor, principal, input }) =>
  getOffer(await app(), { actor, principal }, input.id),
)(securityDeps);
