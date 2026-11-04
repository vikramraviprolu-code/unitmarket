import { IdSchema } from '@umsbx/contracts';
import { revokeKey, withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { apiKeyDeps, app, securityDeps } from '../../../../../server/access';

// API-W0 (F3): revoke one of your own API keys. Another owner's key and a key that does not exist both
// answer the same 404. Revoking twice is still 200 and keeps the first time. A signed in person only.
export const routeMeta: RouteMeta = {
  path: '/api/v1/api-keys/[id]',
  method: 'DELETE',
  auth: 'owner',
  csrf: true,
  rate: { name: 'api_key_revoke', per: 'actor', limit: 30, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

export const DELETE = withRoute(
  routeMeta,
  z.object({ id: IdSchema }).strict(),
  async ({ actor, input }) => {
    const r = await revokeKey(apiKeyDeps(await app()), actor, input.id);
    if (!r.ok) return { status: 404, code: 'not_found', message: 'Not found.' };
    return { status: 200, body: r.value };
  },
)(securityDeps);
