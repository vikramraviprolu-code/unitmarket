import { IdSchema, type Actor } from '@umsbx/contracts';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { app, createApiV1, securityDeps } from '../../../../../server/access';
import { publicMandate } from '../../../../../api-v1/mandate-view';

// API-B (G3): read and revoke one of your own spending caps. Another buyer's cap and one that does not exist
// answer the same 404. Revoking twice is still 200 and keeps the first time. A buyer API client key only.
export const routeMetaGET: RouteMeta = {
  path: '/api/v1/mandates/[id]',
  method: 'GET',
  auth: 'apikey',
  scopes: ['mandates:write'],
  csrf: false,
  rate: { name: 'api_v1_mandate_read', per: 'actor', limit: 300, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

export const routeMetaDELETE: RouteMeta = {
  path: '/api/v1/mandates/[id]',
  method: 'DELETE',
  auth: 'apikey',
  scopes: ['mandates:write'],
  csrf: false,
  rate: { name: 'api_v1_mandate_revoke', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

const Input = z.object({ id: IdSchema }).strict();
const NOT_FOUND = { status: 404, code: 'not_found', message: 'Not found.' } as const;
const FORBIDDEN = {
  status: 403,
  code: 'forbidden',
  message: 'Only a buyer API key can manage a spending cap.',
} as const;
const buyerOnly = (actor: Actor, kind: string | null): string | null =>
  actor.kind === 'buyer' && kind === 'api_client' ? actor.buyer_id : null;

export const GET = withRoute(routeMetaGET, Input, async ({ actor, principal, input }) => {
  const buyer_id = buyerOnly(actor, principal?.kind ?? null);
  if (buyer_id === null) return FORBIDDEN;
  const view = await createApiV1(await app()).mandates.get(buyer_id, input.id);
  return view === null ? NOT_FOUND : { status: 200, body: publicMandate(view) };
})(securityDeps);

export const DELETE = withRoute(routeMetaDELETE, Input, async ({ actor, principal, input }) => {
  const buyer_id = buyerOnly(actor, principal?.kind ?? null);
  if (buyer_id === null) return FORBIDDEN;
  const r = await createApiV1(await app()).mandates.revoke(buyer_id, input.id);
  return r.ok ? { status: 200, body: publicMandate(r.value) } : NOT_FOUND;
})(securityDeps);
