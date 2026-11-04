import {
  SellerOfferIdParamSchema,
  SellerOfferReviseRequestSchema,
  SellerOfferWithdrawQuerySchema,
} from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../../server/access';
import { reviseOffer, withdrawOffer } from '../../../../../../api-v1/seller';

// API-A (seller): see src/api-v1/seller.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMetaDELETE: RouteMeta = {
  path: '/api/v1/seller/offers/[id]',
  method: 'DELETE',
  auth: 'apikey',
  scopes: ['offers:write'],
  csrf: false,
  rate: { name: 'v1_offer_withdraw', per: 'actor', limit: 20, window_ms: 60000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

export const DELETE = withRoute(
  routeMetaDELETE,
  SellerOfferWithdrawQuerySchema.extend(SellerOfferIdParamSchema.shape),
  async ({ actor, principal, input }) =>
    withdrawOffer(await app(), { actor, principal }, input.id, {
      expected_version: input.expected_version,
      reason: input.reason,
    }),
)(securityDeps);

// API-A (seller): see src/api-v1/seller.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMetaPATCH: RouteMeta = {
  path: '/api/v1/seller/offers/[id]',
  method: 'PATCH',
  auth: 'apikey',
  scopes: ['offers:write'],
  csrf: false,
  rate: { name: 'v1_offer_revise', per: 'actor', limit: 20, window_ms: 60000 },
  max_body_bytes: 2048,
  idempotent: true,
  risk: 'high',
};

export const PATCH = withRoute(
  routeMetaPATCH,
  SellerOfferReviseRequestSchema.extend(SellerOfferIdParamSchema.shape),
  async ({ actor, principal, input }) =>
    reviseOffer(await app(), { actor, principal }, input.id, {
      expected_version: input.expected_version,
      options: input.options,
      attestation: input.attestation,
    }),
)(securityDeps);
