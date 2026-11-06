import { IdSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { securityDeps } from '../../../../../../server/access';
import { revokeApiKey } from '../../../../../../composition/ops-agents';
import { REVOKE_REASONS, revokeErrorResult } from '../../../../../../lib/ops-agents-view';

// INT-OPS-C / OPS-C.3: an operator revokes any API or agent key, with a reason code from a closed list (no free text). An
// operator session WITH the second factor, CSRF and an Idempotency-Key, 30 per hour per operator. The write is in
// the Agents and API composition module (C7); the code lands in the audit action in clear. A second revoke answers
// the first one and writes no second audit row; an unknown id is 404.
export const routeMeta: RouteMeta = {
  path: '/api/ops/api-keys/[id]/revoke',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: { name: 'ops_api_key_revoke', per: 'actor', limit: 30, window_ms: 3_600_000 },
  max_body_bytes: 256,
  idempotent: true,
  risk: 'high',
};

const Input = z.object({ id: IdSchema, reason_code: z.enum(REVOKE_REASONS) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await revokeApiKey(actor, { id: input.id, reason_code: input.reason_code });
  return r.ok ? { status: 200, body: r.value } : revokeErrorResult('key', r.error);
})(securityDeps);
