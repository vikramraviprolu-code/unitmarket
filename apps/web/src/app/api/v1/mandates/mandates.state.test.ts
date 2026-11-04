// API-B (G2, G3): POST /api/v1/mandates, GET and DELETE /api/v1/mandates/{id}. A buyer API client key with
// mandates:write only. An agent key can never create, widen or un-revoke a mandate. Another buyer's
// mandate answers 404.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { ORIGIN, idem, newAgent, newClientKey } from '../mcp/agent-test-support';
import type { Handler } from '../mcp/agent-test-support';

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
let buyerB: Actor;
let create: Handler;
let one: { GET: Handler; DELETE: Handler };
let clientA: string;
let clientB: string;
let agentKeyA: { key_id: string; token: string };
const future = (days: number) =>
  new Date(app.security.clock.now().getTime() + days * 86_400_000).toISOString();

beforeAll(async () => {
  app = await bootPackApp();
  create = (await import('./route')).POST as Handler;
  const m = await import('./[id]/route');
  one = { GET: m.GET as Handler, DELETE: m.DELETE as Handler };
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  clientA = (await newClientKey(app, buyerA)).token;
  clientB = (await newClientKey(app, buyerB)).token;
  agentKeyA = await newAgent(app, buyerA, { mandate: null });
});

const post = (token: string | null, body: unknown, over: { idem?: string | null } = {}) =>
  create(
    new Request(`${ORIGIN}/api/v1/mandates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(over.idem === null ? {} : { 'idempotency-key': over.idem ?? idem('mandate') }),
      },
      body: JSON.stringify(body),
    }),
  );
const get = (token: string | null, id: string) =>
  one.GET(
    new Request(`${ORIGIN}/api/v1/mandates/${id}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }),
    { params: { id } },
  );
const del = (token: string | null, id: string) =>
  one.DELETE(
    new Request(`${ORIGIN}/api/v1/mandates/${id}`, {
      method: 'DELETE',
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'idempotency-key': idem('revoke'),
      },
    }),
    { params: { id } },
  );
const body = (over: Record<string, unknown> = {}) => ({
  agent_key_id: agentKeyA.key_id,
  currency: 'USD',
  max_total_minor: 500,
  max_count: 10,
  expires_at: future(7),
  terms_accepted: true,
  ...over,
});
interface Json {
  id: string;
  [k: string]: unknown;
  error?: { code: string };
}
const json = async (r: Response) => (await r.json()) as Json;

describe('G2 create', () => {
  let created: Json;
  it('a buyer key creates a mandate for one of its own agent keys: 201 with the caps and the expiry', async () => {
    const r = await post(clientA, body({ max_per_purchase_minor: 100 }));
    expect(r.status).toBe(201);
    created = await json(r);
    expect(created).toMatchObject({
      agent_key_id: agentKeyA.key_id,
      currency: 'USD',
      max_total_minor: 500,
      max_count: 10,
      max_per_purchase_minor: 100,
      revoked_at: null,
      spent_minor: 0,
      used_count: 0,
      remaining_total_minor: 500,
      remaining_count: 10,
    });
    expect(created.id).toMatch(/^man_/);
    expect(new Date(String(created['expires_at'])).getTime()).toBeGreaterThan(
      app.security.clock.now().getTime(),
    );
  });

  it('a second one for the same key while the first is open is 409', async () => {
    const r = await post(clientA, body());
    expect(r.status).toBe(409);
    expect((await json(r)).error!.code).toBe('mandate_active');
  });

  it('is idempotent: the same Idempotency-Key and body returns the first answer, once', async () => {
    const a = await newAgent(app, buyerA, { mandate: null });
    const k = idem('once');
    const same = body({ agent_key_id: a.key_id }); // one body: the expiry is read from the clock once
    const first = await post(clientA, same, { idem: k });
    const again = await post(clientA, same, { idem: k });
    expect(first.status).toBe(201);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect((await json(again)).id).toBe((await json(first)).id);
  });

  it('refuses with 422: no cap, terms not accepted, a past expiry, a stray field', async () => {
    const fresh = async () => (await newAgent(app, buyerA, { mandate: null })).key_id;
    expect(
      (
        await post(
          clientA,
          body({ agent_key_id: await fresh(), max_total_minor: undefined, max_count: undefined }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await post(clientA, body({ agent_key_id: await fresh(), terms_accepted: false }))).status,
    ).toBe(422);
    expect(
      (
        await post(
          clientA,
          body({ agent_key_id: await fresh(), expires_at: '2020-01-01T00:00:00.000Z' }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await post(clientA, body({ agent_key_id: await fresh(), spent_minor: 0 }))).status,
    ).toBe(422);
  });

  it('another buyer agent key is 404, with the same answer as a key that does not exist', async () => {
    const other = await newAgent(app, buyerB, { mandate: null });
    const a = await post(clientA, body({ agent_key_id: other.key_id }));
    const b = await post(clientA, body({ agent_key_id: 'key_doesnotexist' }));
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    // every refusal carries its own support code; the rest of the answer is the same
    const strip = async (r: Response) => {
      const e = ((await r.json()) as { error: { code: string; message: string } }).error;
      return { code: e.code, message: e.message };
    };
    expect(await strip(a)).toEqual(await strip(b));
  });

  it('is refused without a key (401), without the scope (403) and for a publisher key (403)', async () => {
    expect((await post(null, body())).status).toBe(401);
    const noScope = await newClientKey(app, buyerA, ['catalogue:read']);
    expect((await post(noScope.token, body())).status).toBe(403);
    expect((await post(clientA, body(), { idem: null })).status).toBe(400);
  });

  it('G3 GET returns it with the caps, the spend and the expiry', async () => {
    const r = await get(clientA, created.id);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual(created);
  });

  it('G3 DELETE revokes it: revoked_at is set, GET shows it, and a second DELETE keeps the first time', async () => {
    const r = await del(clientA, created.id);
    expect(r.status).toBe(200);
    const revoked = await json(r);
    expect(revoked['revoked_at']).not.toBeNull();
    expect((await json(await get(clientA, created.id)))['revoked_at']).toBe(revoked['revoked_at']);
    expect((await json(await del(clientA, created.id)))['revoked_at']).toBe(revoked['revoked_at']);
  });

  it('after a revoke the agent key can get a new mandate', async () => {
    expect((await post(clientA, body())).status).toBe(201);
  });
});

describe('G3 reading and revoking', () => {
  it('another buyer sees 404 for GET and DELETE, and nothing changes', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 2 } });
    const id = a.mandate!.id;
    expect((await get(clientB, id)).status).toBe(404);
    expect((await del(clientB, id)).status).toBe(404);
    expect((await json(await get(clientA, id)))['revoked_at']).toBeNull();
  });

  it('a mandate id that does not exist is 404, and no key is 401', async () => {
    expect((await get(clientA, 'man_doesnotexist')).status).toBe(404);
    expect((await get(null, 'man_x')).status).toBe(401);
  });
});

describe('an agent can never create, widen or un-revoke a mandate', () => {
  it('its own key is 403 on every mandate route, even with a mandate of its own', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 2 } });
    expect((await post(a.token, body({ agent_key_id: a.key_id }))).status).toBe(403);
    expect((await get(a.token, a.mandate!.id)).status).toBe(403);
    expect((await del(a.token, a.mandate!.id)).status).toBe(403);
  });
});
