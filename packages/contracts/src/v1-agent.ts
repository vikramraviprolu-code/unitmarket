// API-B (G2, G3, G4): the documented routes of the agent spending cap and the MCP endpoint. Kept in its own
// file so the registry in v1.ts takes one spread from here and lanes A and C add their routes beside it.
import { z } from 'zod';
import type { RouteDoc } from './v1';
import { MandateCreateRequestSchema, MandateViewSchema } from './mandates';

/** The JSON-RPC 2.0 request the MCP endpoint takes. Its tools are named in /.well-known/mcp and tools/list. */
export const McpRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(200), z.number()]).optional(),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();

/** The JSON-RPC 2.0 answer: a result, or an error with a code. */
export const McpResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(200), z.number(), z.null()]),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .optional(),
  })
  .strict();

export const AGENT_ROUTES: readonly RouteDoc[] = [
  {
    method: 'POST',
    path: '/api/v1/mandates',
    summary:
      'Give one of your agent keys a spending cap: money, a number of purchases, or both, in one currency, until an expiry. One open cap per key. An agent key cannot call this.',
    auth: 'apikey',
    scopes: ['mandates:write'],
    input: { in: 'body', schema: MandateCreateRequestSchema },
    success: { status: 201, schema: MandateViewSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/mandates/{id}',
    summary:
      'Read one of your caps with what is spent and what is left. Another buyer cap answers 404.',
    auth: 'apikey',
    scopes: ['mandates:write'],
    input: { in: 'none' },
    success: { status: 200, schema: MandateViewSchema },
    errors: [404],
  },
  {
    method: 'DELETE',
    path: '/api/v1/mandates/{id}',
    summary: 'Revoke a cap. Purchases already booked stay booked; no new purchase can use it.',
    auth: 'apikey',
    scopes: ['mandates:write'],
    input: { in: 'none' },
    success: { status: 200, schema: MandateViewSchema },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/api/v1/mcp',
    summary:
      'The MCP endpoint (JSON-RPC 2.0 over HTTP) for an agent key: initialize, tools/list and tools/call for search_catalogue, get_offer, propose_pack, open_unit, check_budget and buy_unit.',
    auth: 'apikey',
    scopes: ['catalogue:read'],
    input: { in: 'body', schema: McpRequestSchema },
    success: { status: 200, schema: McpResponseSchema },
    errors: [400, 409, 422],
  },
];
