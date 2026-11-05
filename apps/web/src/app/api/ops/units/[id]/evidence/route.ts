import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readUnitEvidence } from '../../../../../../composition/ops-controls';
import { securityDeps } from '../../../../../../server/access';

// INT-TR1 / TR1.5: the evidence pack of one unit, for an operator session with the second factor only.
export const routeMeta: RouteMeta = {
  path: '/api/ops/units/[id]/evidence',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_unit_evidence', per: 'actor', limit: 30, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({ id: z.string().min(1).max(200) }).strict();

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  if (actor.kind !== 'operator' || !actor.mfa)
    return {
      status: 403,
      code: 'mfa_required',
      message: 'The evidence pack needs the second factor.',
    };
  const p = await readUnitEvidence(input.id);
  return p === null
    ? { status: 404, code: 'not_found', message: 'We could not find that unit.' }
    : { status: 200, body: p };
})(securityDeps);
