// API-B (G4): the JSON-RPC 2.0 side of the MCP server, by hand, no dependency. One request, one answer; a
// batch is not supported. A bad call is a JSON-RPC error with HTTP 200; a bad key, a missing header or a body
// that is too large never reach this file (the route wrapper answers them with the usual envelope). Tool
// refusals are not JSON-RPC errors: they are tool results with isError, so an agent reads them like any answer.
import { extendTraceContext } from '@umsbx/obs';
import { TOOL_NAMES, callTool, describeTools } from '../../../../api-v1/agent';
import type { AgentCall, ToolName } from '../../../../api-v1/agent';

/** Newest first. A client that asks for another version is offered the first one. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const SERVER_INSTRUCTIONS =
  'UnitMarket sells single articles to AI agents on behalf of a buyer. You can search and read offers freely. ' +
  'You can only buy inside a spending cap (a mandate) your buyer set: call check_budget first. With no cap you ' +
  'must ask your buyer to set one (money, number of purchases, or both, and an expiry); you can never set or ' +
  'raise it yourself. Always send an idempotency_key with buy_unit.';

export interface RpcInput {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export type RpcOutcome =
  { kind: 'response'; body: Record<string, unknown> } | { kind: 'notification' };

type RpcId = string | number | null;

const isId = (v: unknown): v is string | number =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isToolName = (v: unknown): v is ToolName =>
  typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);

const reply = (id: RpcId, result: Record<string, unknown>): RpcOutcome => ({
  kind: 'response',
  body: { jsonrpc: '2.0', id, result },
});
const fail = (id: RpcId, code: number, message: string): RpcOutcome => ({
  kind: 'response',
  body: { jsonrpc: '2.0', id, error: { code, message } },
});

export async function dispatch(call: AgentCall, req: RpcInput): Promise<RpcOutcome> {
  const hasId = req.id !== undefined;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string' || (hasId && !isId(req.id))) {
    return fail(hasId && isId(req.id) ? req.id : null, -32600, 'Invalid Request');
  }
  // A notification has no id and gets no answer.
  if (!hasId) return { kind: 'notification' };
  const id = req.id as string | number;
  const params = req.params;

  switch (req.method) {
    case 'initialize': {
      const asked = isRecord(params) ? params['protocolVersion'] : undefined;
      const version = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
        ? (asked as string)
        : PROTOCOL_VERSIONS[0];
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'unitmarket', version: '1.0.0' },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: describeTools() });
    case 'tools/call': {
      if (!isRecord(params) || !isToolName(params['name'])) {
        return fail(id, -32602, 'Invalid params: name must be one of the tools');
      }
      const args = params['arguments'] === undefined ? {} : params['arguments'];
      if (!isRecord(args)) return fail(id, -32602, 'Invalid params: arguments must be an object');
      // INT-TR0: the writes of a tool call are journaled on the mcp channel, with the tool's name.
      const name = params['name'];
      const r = await extendTraceContext({ channel: 'mcp', tool: name }, () =>
        callTool(call, name, args),
      );
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(r.out) }],
        structuredContent: r.out,
        isError: r.isError,
      });
    }
    default:
      return fail(id, -32601, `Method not found: ${req.method.slice(0, 100)}`);
  }
}
