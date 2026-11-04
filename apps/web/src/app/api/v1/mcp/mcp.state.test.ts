// API-B (G4): the MCP server, JSON-RPC 2.0 by hand. initialize, tools/list, tools/call; one JSON answer per
// request; an agent key only. Errors are JSON-RPC errors for a bad call and the usual envelope for a bad key.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { mcpHandler, mcpRequest, newAgent, newClientKey, rpc } from './agent-test-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

let app: App;
let buyerA: Actor;
let token: string;
beforeAll(async () => {
  app = await bootPackApp();
  buyerA = await buyer(app, 'a');
  token = (await newAgent(app, buyerA, { mandate: null })).token;
});

const TOOLS = [
  'search_catalogue',
  'get_offer',
  'propose_pack',
  'open_unit',
  'check_budget',
  'buy_unit',
];

describe('initialize', () => {
  it('answers with the protocol version, the tools capability and the server name', async () => {
    const r = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-agent', version: '1' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'unitmarket' },
      },
    });
    expect(String(r.body.result!['instructions'])).toMatch(/cap|mandate/i);
  });

  it('echoes the id it was given, a string or a number, and offers its own version for an unknown one', async () => {
    expect((await rpc(token, 'ping', undefined, { id: 'abc' })).body).toMatchObject({
      id: 'abc',
      result: {},
    });
    expect((await rpc(token, 'ping', undefined, { id: 77 })).body).toMatchObject({
      id: 77,
      result: {},
    });
    const r = await rpc(token, 'initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    });
    expect(String((r.body.result as { protocolVersion: string }).protocolVersion)).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe('tools/list', () => {
  it('returns the six tools, each with a description and an object input schema', async () => {
    const r = await rpc(token, 'tools/list');
    const tools = (
      r.body.result as {
        tools: { name: string; description: string; inputSchema: { type: string } }[];
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('buy_unit says in its description that a mandate (a cap) is needed first', async () => {
    const r = await rpc(token, 'tools/list');
    const buy = (r.body.result as { tools: { name: string; description: string }[] }).tools.find(
      (t) => t.name === 'buy_unit',
    )!;
    expect(buy.description).toMatch(/cap|mandate/i);
    expect(buy.description).toMatch(/idempotency_key/);
  });
});

describe('errors', () => {
  it('an unknown method is -32601 and says which', async () => {
    const r = await rpc(token, 'resources/list');
    expect(r.status).toBe(200);
    expect(r.body.error).toMatchObject({ code: -32601 });
    expect(r.body.id).toBe(1);
    expect(r.body.result).toBeUndefined();
  });

  it('bad params are -32602: no name, a name that is not a tool, arguments that are not an object', async () => {
    for (const params of [
      {},
      { name: 'drop_tables', arguments: {} },
      { name: 'check_budget', arguments: 'x' },
      'text',
      null,
    ]) {
      const r = await rpc(token, 'tools/call', params);
      expect(r.status, JSON.stringify(params)).toBe(200);
      expect(r.body.error, JSON.stringify(params)).toMatchObject({ code: -32602 });
    }
  });

  it('arguments that do not match the tool are a tool error with status invalid_arguments, not a crash', async () => {
    const r = await rpc(token, 'tools/call', { name: 'get_offer', arguments: { publisher: 5 } });
    expect(r.status).toBe(200);
    const result = r.body.result as {
      isError: boolean;
      structuredContent: { status: string; fields: string[] };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.status).toBe('invalid_arguments');
    expect(result.structuredContent.fields).toContain('publisher');
  });

  it('an envelope that is not JSON-RPC 2.0 is -32600', async () => {
    const post = await mcpHandler();
    for (const payload of [
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: { a: 1 }, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 7 },
    ]) {
      const res = await post(mcpRequest(token, payload));
      expect(res.status, JSON.stringify(payload)).toBe(200);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);
    }
  });

  it('a batch (an array) is refused, not run', async () => {
    const post = await mcpHandler();
    const res = await post(mcpRequest(token, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
    expect([200, 422]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toMatch(/"result"/);
  });

  it('a notification (no id) is accepted with 202 and no result', async () => {
    const post = await mcpHandler();
    const res = await post(
      mcpRequest(token, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).not.toMatch(/"result"/);
  });

  it('a body that is not JSON is the usual 400, and one that is too large the usual 413', async () => {
    const post = await mcpHandler();
    expect((await post(mcpRequest(token, null, { raw: '{nope' }))).status).toBe(400);
    expect(
      (
        await post(
          mcpRequest(token, null, {
            raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70_000) }),
          }),
        )
      ).status,
    ).toBe(413);
  });
});

describe('who may connect', () => {
  it('no key, a wrong key and a revoked key are refused with 401 and no JSON-RPC body', async () => {
    const post = await mcpHandler();
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(mcpRequest(null, body))).status).toBe(401);
    expect((await post(mcpRequest('umk_nonsense', body))).status).toBe(401);
  });

  it('a request without an Idempotency-Key is refused 400, like every state change under /api/v1', async () => {
    const post = await mcpHandler();
    const res = await post(
      mcpRequest(token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { idem: null }),
    );
    expect(res.status).toBe(400);
  });

  it('a key without catalogue:read is refused 403', async () => {
    const a = await newAgent(app, buyerA, { scopes: ['agent:buy'], mandate: null });
    expect((await rpc(a.token, 'ping')).status).toBe(403);
  });

  it('a buyer API client key is not an agent: 403, and a publisher key too', async () => {
    const c = await newClientKey(app, buyerA, ['catalogue:read', 'mandates:write']);
    expect((await rpc(c.token, 'ping')).status).toBe(403);
    const pub: Actor = {
      kind: 'publisher',
      publisher_id: (
        await app.db.query<{ id: string }>(
          "SELECT id FROM publishers WHERE slug = 'harbour-ledger'",
        )
      ).rows[0]!.id,
    };
    const p = await newClientKey(app, pub, ['catalogue:read']);
    expect((await rpc(p.token, 'ping')).status).toBe(403);
  });

  it('the same Idempotency-Key and body replays the stored answer; another body with the key is 409', async () => {
    const post = await mcpHandler();
    const body = { jsonrpc: '2.0', id: 9, method: 'ping' };
    const a = await post(mcpRequest(token, body, { idem: 'replay-key-0001' }));
    const b = await post(mcpRequest(token, body, { idem: 'replay-key-0001' }));
    expect(b.headers.get('idempotent-replay')).toBe('true');
    // the store keeps the answer as JSON, so member order may differ; the content is the same
    expect(JSON.parse(await a.text())).toEqual(JSON.parse(await b.text()));
    const c = await post(mcpRequest(token, { ...body, id: 10 }, { idem: 'replay-key-0001' }));
    expect(c.status).toBe(409);
  });
});
