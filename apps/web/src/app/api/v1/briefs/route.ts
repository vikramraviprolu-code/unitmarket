import { BriefCreateRequestSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { createBrief } from '../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/briefs',
  method: 'POST',
  auth: 'apikey',
  scopes: ['catalogue:read'],
  csrf: false,
  rate: { name: 'v1_brief', per: 'actor', limit: 20, window_ms: 3600000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'medium',
};

export const POST = withRoute(
  routeMeta,
  BriefCreateRequestSchema,
  async ({ actor, principal, input }) => createBrief(await app(), { actor, principal }, input),
)(securityDeps);
