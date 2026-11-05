import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ACTOR_KINDS, CHANNELS, IsoUtcSchema } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { readOpsActivity } from '../../../../composition/ops-controls';
import { securityDeps } from '../../../../server/access';

// INT-TR1 / TR1.4: the activity log. Newest first, 50 to a page (200 at most), filters combined with AND.
// The cursor is bound to the filters and the operator: one made for another set of filters is bad_cursor.
export const routeMeta: RouteMeta = {
  path: '/api/ops/activity',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_activity', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Name = z.string().min(1).max(200);
const Input = z
  .object({
    actor_kind: z.enum(ACTOR_KINDS).optional(),
    actor_id: Name.optional(),
    channel: z.enum(CHANNELS).optional(),
    event_type: Name.optional(),
    chain_key: Name.optional(),
    from: IsoUtcSchema.optional(),
    to: IsoUtcSchema.optional(),
    limit: z
      .string()
      .regex(/^\d{1,6}$/)
      .optional(),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  if (actor.kind !== 'operator')
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  const { limit, cursor, ...filters } = input;
  const keys = Object.keys(filters).sort() as (keyof typeof filters)[];
  const h = createHash('sha256')
    .update(
      JSON.stringify([actor.operator_id, actor.mfa, keys.map((k) => [k, filters[k]])]),
      'utf8',
    )
    .digest('hex')
    .slice(0, 16);
  const r = await readOpsActivity({
    filters,
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    h,
    mfa: actor.mfa,
  });
  if (r.ok) return { status: 200, body: { items: r.items, next_cursor: r.next_cursor } };
  return r.error === 'bad_cursor'
    ? {
        status: 400,
        code: 'bad_cursor',
        message: 'That page marker is not valid. Start again from the first page.',
      }
    : { status: 403, code: 'mfa_required', message: 'Filtering by actor needs the second factor.' };
})(securityDeps);
