import { ApprovalRequestSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { createApproval } from '../../../../api-v1/buyer';
import { app, securityDeps } from '../../../../server/access';

// API-A (buyer): see src/api-v1/buyer.ts and docs/specs/api-a-endpoints.md. A bearer key with the scope below.
export const routeMeta: RouteMeta = {
  path: '/api/v1/approvals',
  method: 'POST',
  auth: 'apikey',
  scopes: ['orders:write'],
  csrf: false,
  rate: { name: 'v1_approval', per: 'actor', limit: 10, window_ms: 3600000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'high',
};

export const POST = withRoute(
  routeMeta,
  ApprovalRequestSchema,
  async ({ actor, principal, input }) => createApproval(await app(), { actor, principal }, input),
)(securityDeps);
