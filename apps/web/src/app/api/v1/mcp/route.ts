import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, createApiV1, securityDeps } from '../../../../server/access';
import type { AgentCall } from '../../../../api-v1/agent';
import { dispatch } from './dispatch';

// API-B (G4): the MCP server for AI agents, JSON-RPC 2.0 over one POST. An agent key only: a buyer's API
// client key or a publisher's key is refused, however many scopes it holds. The route needs catalogue:read;
// each tool then checks the scope it needs (library:read, agent:buy). The Idempotency-Key header is required
// like on every state change under /api/v1 (a replay returns the stored answer); buy_unit also has its own
// idempotency_key argument, which is what makes a retried purchase safe.
export const routeMeta: RouteMeta = {
  path: '/api/v1/mcp',
  method: 'POST',
  auth: 'apikey',
  scopes: ['catalogue:read'],
  csrf: false,
  rate: { name: 'api_v1_mcp', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 65_536,
  idempotent: true,
  risk: 'high',
};

// A JSON-RPC envelope. Every member is checked by the dispatcher, so a bad one is a JSON-RPC error (-32600),
// not a 422; an array (a batch) or an unknown member does not match and is refused.
const Envelope = z
  .object({
    jsonrpc: z.unknown().optional(),
    id: z.unknown().optional(),
    method: z.unknown().optional(),
    params: z.unknown().optional(),
  })
  .strict();

export const POST = withRoute(routeMeta, Envelope, async ({ principal, scopes, input }) => {
  if (principal === null || principal.kind !== 'agent') {
    return { status: 403, code: 'forbidden', message: 'Only an agent key can use the MCP server.' };
  }
  const a = await app();
  const v1 = createApiV1(a);
  const call: AgentCall = {
    ctx: {
      engine: a.engine,
      mandates: v1.mandates,
      claims: v1.claims,
      origin: a.security.public_origin,
      environment: a.environment === 'sandbox' ? 'sandbox' : 'dryrun',
    },
    key_id: principal.key_id,
    buyer_id: principal.buyer_id,
    scopes,
    exposure: a.security.exposure,
  };
  const r = await dispatch(call, input);
  if (r.kind === 'notification') return { status: 202, body: {} };
  return { status: 200, body: r.body };
})(securityDeps);
