import { EntitlementIdParamSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { issueLibraryLink } from '../../../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/library/[id]/link',
  method: 'POST',
  auth: 'apikey',
  scopes: ['library:read'],
  csrf: false,
  rate: { name: 'v1_link', per: 'actor', limit: 60, window_ms: 3600000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'medium',
};

export const POST = withRoute(
  routeMeta,
  EntitlementIdParamSchema,
  async ({ actor, principal, input }) =>
    issueLibraryLink(await app(), { actor, principal }, input.id),
)(securityDeps);
