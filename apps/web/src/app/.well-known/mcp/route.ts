import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { securityDeps } from '../../../server/access';
import { TOOL_NAMES } from '../../../api-v1/agent';

// API-B (G11): the discovery file an agent client reads to find the MCP endpoint. No key is needed and it
// holds no secret: the endpoint of this app, the tool names, how to authenticate and the headers to send.
export const routeMeta: RouteMeta = {
  path: '/.well-known/mcp',
  method: 'GET',
  auth: 'public',
  csrf: false,
  rate: { name: 'well_known_mcp', per: 'ip', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

export const GET = withRoute(routeMeta, z.object({}).strict(), async () => {
  const origin = securityDeps.public_origin;
  return {
    status: 200,
    body: {
      name: 'unitmarket',
      endpoint: `${origin}/api/v1/mcp`,
      transport: 'json-rpc-over-http',
      tools: [...TOOL_NAMES],
      auth: {
        scheme: 'bearer',
        description: 'An agent API key issued by the buyer, sent as Authorization: Bearer.',
        scopes: ['catalogue:read', 'library:read', 'agent:buy'],
      },
      required_headers: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      cap: 'Buying needs a spending cap from your buyer. Call check_budget first.',
    },
  };
})(securityDeps);
