// INT-CTL / CTL.5: the exposure registry on the real routes. A disabled REST group answers a bearer key with
// 403 api_disabled; a disabled MCP tool is gone from tools/list and refused in tools/call with isError; REST and
// MCP groups are independent; `mcp` off refuses the route. The MCP entries of API_GROUPS equal TOOL_NAMES.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_GROUPS } from '@umsbx/contracts';
import type { Actor } from '@umsbx/contracts';
import { TOOL_NAMES } from '../../../../api-v1/agent';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { idemKey } from '../../../../api-v1/a-support';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { mcpHandler, mcpRequest, newAgent, newClientKey, rpc, tool } from './agent-test-support';

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
let agent: string;
let client: string;
const setGroup = (g: string, enabled: boolean) =>
  app.db.query(
    `UPDATE api_exposure SET enabled = $2, changed_by = 'test', changed_at = $3, reason_code = 'other', updated_at = $3 WHERE group_name = $1`,
    [g, enabled, app.security.clock.now().toISOString()],
  );
const get = async (url: string, token: string | null) => {
  const route = (await import('../orders/route')).GET as never as (r: Request) => Promise<Response>;
  return route(
    new Request(`http://localhost:3000${url}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }),
  );
};
const code = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  app = await bootPackApp();
  buyerA = await buyer(app, 'a');
  agent = (await newAgent(app, buyerA, { mandate: null })).token;
  client = (await newClientKey(app, buyerA, ['orders:read', 'orders:write', 'catalogue:read']))
    .token;
});
afterAll(async () => {
  for (const g of API_GROUPS) await setGroup(g, true);
  await app.close();
});

describe('the registry and the tools', () => {
  it('the MCP entries of API_GROUPS equal TOOL_NAMES, in order', () => {
    expect(API_GROUPS.filter((g) => g.startsWith('mcp:')).map((g) => g.slice(4))).toEqual([
      ...TOOL_NAMES,
    ]);
  });
});

describe('a disabled REST group', () => {
  it('orders off: a bearer GET /api/v1/orders is 403 api_disabled; with no key it is 401 unauthenticated', async () => {
    expect((await get('/api/v1/orders', client)).status).toBe(200);
    await setGroup('orders', false);
    try {
      const off = await get('/api/v1/orders', client);
      expect(off.status).toBe(403);
      expect(await code(off)).toBe('api_disabled');
      const anon = await get('/api/v1/orders', null);
      expect(anon.status).toBe(401);
      expect(await code(anon)).toBe('unauthenticated');
    } finally {
      await setGroup('orders', true);
    }
    expect((await get('/api/v1/orders', client)).status).toBe(200);
  });

  it('a replayed Idempotency-Key after the disable is 403 api_disabled, never the stored 200', async () => {
    const post = (await import('../quotes/route')).POST as never as (
      r: Request,
    ) => Promise<Response>;
    const key = idemKey();
    const send = () =>
      post(
        new Request('http://localhost:3000/api/v1/quotes', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${client}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({
            publisher: 'harbour-ledger',
            offer: 'tide-tables',
            option: 'online_read',
          }),
        }),
      );
    const first = await send();
    expect(first.status).toBe(200);
    await setGroup('orders', false);
    try {
      const replay = await send();
      expect(replay.status).toBe(403);
      expect(await code(replay)).toBe('api_disabled');
    } finally {
      await setGroup('orders', true);
    }
  });

  it('the buyer session routes keep working while every REST group is off', async () => {
    const { signIn } = await import('../../../../support');
    const session = await import('../../session/route');
    const library = await import('../../library/route');
    const s = await signIn(session.POST as never, 'buyer-a');
    expect(s).not.toBeNull();
    for (const g of API_GROUPS.filter((x) => !x.startsWith('mcp'))) await setGroup(g, false);
    try {
      const res = await (library.GET as never as (r: Request) => Promise<Response>)(
        new Request('http://localhost:3000/api/library', { headers: { cookie: s!.cookie } }),
      );
      expect(res.status).toBe(200);
    } finally {
      for (const g of API_GROUPS.filter((x) => !x.startsWith('mcp'))) await setGroup(g, true);
    }
  });
});

describe('MCP tools', () => {
  it('a disabled tool is absent from tools/list and refused in tools/call with isError and api_disabled', async () => {
    const before = await rpc(agent, 'tools/list');
    const names = (before.body.result!['tools'] as { name: string }[]).map((t) => t.name);
    expect(names).toEqual([...TOOL_NAMES]);
    await setGroup('mcp:buy_unit', false);
    try {
      const after = await rpc(agent, 'tools/list');
      expect((after.body.result!['tools'] as { name: string }[]).map((t) => t.name)).toEqual(
        TOOL_NAMES.filter((n) => n !== 'buy_unit'),
      );
      const call = await tool(agent, 'buy_unit', {
        publisher: 'harbour-ledger',
        offer: 'tide-tables',
        idempotency_key: idemKey(),
      });
      expect(call.status).toBe(200);
      expect(call.isError).toBe(true);
      expect(call.out.status).toBe('api_disabled');
      expect(call.text).toContain('api_disabled');
      // the other tools still answer
      expect((await tool(agent, 'check_budget')).out.status).not.toBe('api_disabled');
    } finally {
      await setGroup('mcp:buy_unit', true);
    }
    const again = await rpc(agent, 'tools/list');
    expect((again.body.result!['tools'] as unknown[]).length).toBe(TOOL_NAMES.length);
  });

  it('REST and MCP groups are independent: orders off keeps mcp:buy_unit, mcp:buy_unit off keeps POST /api/v1/orders reachable', async () => {
    await setGroup('orders', false);
    try {
      const names = (
        (await rpc(agent, 'tools/list')).body.result!['tools'] as { name: string }[]
      ).map((t) => t.name);
      expect(names).toContain('buy_unit');
      expect(
        (
          await tool(agent, 'buy_unit', {
            publisher: 'harbour-ledger',
            offer: 'tide-tables',
            idempotency_key: idemKey(),
          })
        ).out.status,
      ).not.toBe('api_disabled');
    } finally {
      await setGroup('orders', true);
    }
    await setGroup('mcp:buy_unit', false);
    try {
      expect((await get('/api/v1/orders', client)).status).toBe(200);
    } finally {
      await setGroup('mcp:buy_unit', true);
    }
  });

  it('mcp off refuses the whole route with 403 api_disabled, for every method', async () => {
    await setGroup('mcp', false);
    try {
      const post = await mcpHandler();
      const res = await post(mcpRequest(agent, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('api_disabled');
      const anon = await post(mcpRequest(null, { jsonrpc: '2.0', id: 1, method: 'ping' }));
      expect(anon.status).toBe(401);
    } finally {
      await setGroup('mcp', true);
    }
    expect((await rpc(agent, 'ping')).status).toBe(200);
  });
});
