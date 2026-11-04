import { SellerOfferCreateRequestSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, securityDeps } from '../../../../../server/access';
import { createOffer, listOffers } from '../../../../../api-v1/seller';

// API-A (seller): see src/api-v1/seller.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMetaGET: RouteMeta = {
  path: '/api/v1/seller/offers',
  method: 'GET',
  auth: 'apikey',
  scopes: ['catalogue:read'],
  csrf: false,
  rate: { name: 'v1_seller_list', per: 'actor', limit: 120, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMetaGET, z.object({}).strict(), async ({ actor, principal }) =>
  listOffers(await app(), { actor, principal }),
)(securityDeps);

// API-A (seller): see src/api-v1/seller.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMetaPOST: RouteMeta = {
  path: '/api/v1/seller/offers',
  method: 'POST',
  auth: 'apikey',
  scopes: ['offers:write'],
  csrf: false,
  rate: { name: 'v1_offer_create', per: 'actor', limit: 20, window_ms: 60000 },
  max_body_bytes: 2048,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(
  routeMetaPOST,
  SellerOfferCreateRequestSchema,
  async ({ actor, principal, input }) => createOffer(await app(), { actor, principal }, input),
)(securityDeps);
