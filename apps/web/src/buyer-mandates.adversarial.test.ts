// INT-BUY / BUY.1 (L): attacks on the two session routes that let a signed-in buyer give an agent key a spending
// cap and take it back. The routes call domain/mandates unchanged. An agent key never creates, widens or revokes a
// cap: it holds no session, so it cannot reach these routes. Refusal statuses are the non-v1 ones (422 and 403),
// as route.ts answers them. Build notes N1 (revoke body is {}) and N3 (the race uses two Idempotency-Keys).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootA, idemKey, json } from './api-v1/a-support';
import type { ARig, Handler, Sess } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import {
  buyArgs,
  extraOffers,
  newAgent,
  newClientKey,
  setAgentBuy,
  tool,
} from './app/api/v1/mcp/agent-test-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

type Buyer = Extract<Actor, { kind: 'buyer' }>;
interface Err {
  error: { code: string; message: string; fields?: string[] };
}
let rig: ARig;
let A: Buyer;
let B: Buyer;
let sessA: Sess;
let sessB: Sess;
let create: Handler;
let revoke: Handler;

const future = (days: number) =>
  new Date(rig.app.security.clock.now().getTime() + days * 86_400_000).toISOString();
const body = (agent_key_id: string, over: Record<string, unknown> = {}) => ({
  agent_key_id,
  currency: 'USD',
  max_total_minor: 500,
  max_count: 10,
  expires_at: future(7),
  terms_accepted: true,
  ...over,
});
const post = (
  s: Sess | null,
  b: unknown,
  o: { idem?: string | null; headers?: Record<string, string> } = {},
) =>
  rig.old(create, s, {
    method: 'POST',
    url: '/api/buyer/mandates',
    body: b,
    idem: o.idem === undefined ? idemKey() : o.idem,
    ...(o.headers ? { headers: o.headers } : {}),
  });
const del = (s: Sess | null, id: string, o: { idem?: string | null } = {}) =>
  rig.old(revoke, s, {
    method: 'POST',
    url: `/api/buyer/mandates/${id}/revoke`,
    body: {},
    idem: o.idem === undefined ? idemKey() : o.idem,
    params: { id },
  });
const withoutSupport = (e: Err) => ({ code: e.error.code, message: e.error.message });
const rowsOf = async (sql: string, p: unknown[] = []) =>
  (await rig.app.db.query<Record<string, unknown>>(sql, p)).rows;

beforeAll(async () => {
  rig = await bootA();
  A = rig.buyerA as Buyer;
  B = rig.buyerB as Buyer;
  sessA = await rig.session(A);
  sessB = await rig.session(B);
  create = (await import('./app/api/buyer/mandates/route')).POST as Handler;
  revoke = (await import('./app/api/buyer/mandates/[id]/revoke/route')).POST as Handler;
  await setAgentBuy(rig.app, true);
}, 120_000);

describe('BUY.1 create', () => {
  it('a signed-in buyer gives its own agent key a cap: 201, no buyer id in the answer', async () => {
    const k = await newAgent(rig.app, A, { mandate: null });
    const res = await post(sessA, body(k.key_id));
    expect(res.status).toBe(201);
    const m = await json<Record<string, unknown>>(res);
    expect(m).toMatchObject({
      agent_key_id: k.key_id,
      max_total_minor: 500,
      max_count: 10,
      revoked_at: null,
      spent_minor: 0,
      used_count: 0,
    });
    expect(String(m['id'])).toMatch(/^man_/);
    expect(JSON.stringify(m)).not.toContain(A.buyer_id);
  });

  it('a body without terms_accepted, or with it false, gives 422 invalid_input naming the field', async () => {
    const k = await newAgent(rig.app, A, { mandate: null });
    const { terms_accepted, ...rest } = body(k.key_id);
    void terms_accepted;
    for (const b of [rest, body(k.key_id, { terms_accepted: false })]) {
      const res = await post(sessA, b);
      expect(res.status).toBe(422);
      const e = await json<Err>(res);
      expect(e.error.code).toBe('invalid_input');
      expect(e.error.fields).toContain('terms_accepted');
    }
    expect(await rowsOf('SELECT 1 FROM mandates WHERE agent_key_id = $1', [k.key_id])).toHaveLength(
      0,
    );
  });

  it('a body with no money cap and no count, or an extra field, is refused', async () => {
    const k = await newAgent(rig.app, A, { mandate: null });
    const none = await post(
      sessA,
      body(k.key_id, { max_total_minor: undefined, max_count: undefined }),
    );
    expect(none.status).toBe(422);
    const extra = await post(sessA, body(k.key_id, { buyer_id: B.buyer_id }));
    expect(extra.status).toBe(422);
    expect(await rowsOf('SELECT 1 FROM mandates WHERE agent_key_id = $1', [k.key_id])).toHaveLength(
      0,
    );
  });

  it('an expiry over 90 days gives 422 invalid_expiry, and one in the past too', async () => {
    const k = await newAgent(rig.app, A, { mandate: null });
    for (const when of [future(91), future(-1)]) {
      const res = await post(sessA, body(k.key_id, { expires_at: when }));
      expect(res.status).toBe(422);
      expect((await json<Err>(res)).error.code).toBe('invalid_expiry');
    }
  });

  it('two concurrent creates on one key (two Idempotency-Keys) give one 201 and one 409 mandate_active', async () => {
    const k = await newAgent(rig.app, A, { mandate: null });
    const rs = await Promise.all([post(sessA, body(k.key_id)), post(sessA, body(k.key_id))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = rs.find((r) => r.status === 409)!;
    expect((await json<Err>(loser)).error.code).toBe('mandate_active');
    expect(await rowsOf('SELECT 1 FROM mandates WHERE agent_key_id = $1', [k.key_id])).toHaveLength(
      1,
    );
  });

  it('a replay with the same key and body returns the stored answer and makes no second cap', async () => {
    const k = await newAgent(rig.app, A, { mandate: null });
    const key = idemKey();
    const b = body(k.key_id);
    const first = await json(await post(sessA, b, { idem: key }));
    const again = await post(sessA, b, { idem: key });
    expect(again.status).toBe(201);
    expect(await json(again)).toEqual(first);
    expect(await rowsOf('SELECT 1 FROM mandates WHERE agent_key_id = $1', [k.key_id])).toHaveLength(
      1,
    );
  });
});

describe('BUY.1 refusals (F10)', () => {
  let k: { key_id: string; token: string };
  beforeAll(async () => {
    k = await newAgent(rig.app, A, { mandate: null });
  });
  it('a bearer header alone is 401 unauthenticated', async () => {
    const res = await post(null, body(k.key_id), {
      headers: { authorization: `Bearer ${k.token}` },
    });
    expect(res.status).toBe(401);
    expect((await json<Err>(res)).error.code).toBe('unauthenticated');
    const gone = await del(null, 'man_whatever');
    expect(gone.status).toBe(401);
  });
  it('a seller or an operator session is 403 forbidden', async () => {
    for (const actor of [rig.harbour, rig.operator]) {
      const s = await rig.session(actor);
      const res = await post(s, body(k.key_id));
      expect(res.status).toBe(403);
      expect((await json<Err>(res)).error.code).toBe('forbidden');
      expect((await del(s, 'man_whatever')).status).toBe(403);
    }
  });
  it('a missing or wrong CSRF token is 403 csrf', async () => {
    const res = await post({ cookie: sessA.cookie, csrf: 'not-the-token' }, body(k.key_id));
    expect(res.status).toBe(403);
    expect((await json<Err>(res)).error.code).toBe('csrf');
  });
  it('a missing Idempotency-Key is 422 idempotency_key', async () => {
    const res = await post(sessA, body(k.key_id), { idem: null });
    expect(res.status).toBe(422);
    expect((await json<Err>(res)).error.code).toBe('idempotency_key');
  });
  it('the same key with another body is 422 idempotency_key_reused', async () => {
    const key = idemKey();
    const first = await post(sessA, body(k.key_id, { max_count: 4 }), { idem: key });
    expect(first.status).toBe(201);
    const res = await post(sessA, body(k.key_id, { max_count: 5 }), { idem: key });
    expect(res.status).toBe(422);
    expect((await json<Err>(res)).error.code).toBe('idempotency_key_reused');
  });
  it('an agent key never creates a cap: a cookie plus an agent bearer is the buyer on the web, never the agent (F2)', async () => {
    const k2 = await newAgent(rig.app, A, { mandate: null });
    const res = await post(sessA, body(k2.key_id), {
      headers: { authorization: `Bearer ${k2.token}` },
    });
    expect(res.status).toBe(201);
    const id = String((await json<Record<string, unknown>>(res))['id']);
    const ev = await rowsOf(
      `SELECT actor_kind, actor_id, channel, on_behalf_of, mandate_id FROM trace_events
        WHERE source_table = 'mandates' AND source_id = $1 AND event_type LIKE '%created%'`,
      [id],
    );
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) {
      expect(e['actor_kind']).toBe('buyer');
      expect(e['actor_id']).toBe(A.buyer_id);
      expect(e['channel']).toBe('web');
      expect(e['on_behalf_of']).toBeNull();
    }
  });
});

describe("BUY.1 another buyer's cap or key is a 404 with the unknown-id body", () => {
  it("buyer A cannot create on buyer B's agent key, on an api_client key, on a revoked key or on an unknown id", async () => {
    const kB = await newAgent(rig.app, B, { mandate: null });
    const client = await newClientKey(rig.app, A);
    const dead = await newAgent(rig.app, A, { mandate: null });
    await rig.app.db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [dead.key_id]);
    const unknown = await post(sessA, body('key_doesnotexist1'));
    expect(unknown.status).toBe(404);
    const want = withoutSupport(await json<Err>(unknown));
    for (const id of [kB.key_id, client.key_id, dead.key_id]) {
      const res = await post(sessA, body(id));
      expect(res.status, id).toBe(404);
      expect(withoutSupport(await json<Err>(res))).toEqual(want);
    }
    expect(
      await rowsOf('SELECT 1 FROM mandates WHERE agent_key_id = $1', [kB.key_id]),
    ).toHaveLength(0);
  });
});

describe('BUY.1 revoke', () => {
  it('ends the cap with an empty body, and a second revoke is 200 with the first revoked_at', async () => {
    const k = await newAgent(rig.app, A, { mandate: { max_count: 3 } });
    const first = await del(sessA, k.mandate!.id);
    expect(first.status).toBe(200);
    const a = await json<Record<string, unknown>>(first);
    expect(a['revoked_at']).not.toBeNull();
    const second = await del(sessA, k.mandate!.id);
    expect(second.status).toBe(200);
    expect((await json<Record<string, unknown>>(second))['revoked_at']).toBe(a['revoked_at']);
  });
  it("buyer A cannot revoke buyer B's cap: 404, the unknown-id body, and the cap stays open", async () => {
    const k = await newAgent(rig.app, B, { mandate: { max_count: 3 } });
    const unknown = await del(sessA, 'man_doesnotexist1');
    expect(unknown.status).toBe(404);
    const res = await del(sessA, k.mandate!.id);
    expect(res.status).toBe(404);
    expect(withoutSupport(await json<Err>(res))).toEqual(withoutSupport(await json<Err>(unknown)));
    const left = await rowsOf('SELECT revoked_at FROM mandates WHERE id = $1', [k.mandate!.id]);
    expect(left[0]!['revoked_at']).toBeNull();
    expect((await del(sessB, k.mandate!.id)).status).toBe(200);
  });
  it('a revoked cap refuses the next buy_unit', async () => {
    const [offer] = await extraOffers(rig.app, {
      publisher: 'harbour-ledger',
      from: 'tide-tables',
      count: 1,
      price_minor: 30,
    });
    const k = await newAgent(rig.app, A, { mandate: { max_count: 3 } });
    expect((await del(sessA, k.mandate!.id)).status).toBe(200);
    const r = await tool(k.token, 'buy_unit', buyArgs('harbour-ledger', offer!));
    expect(r.out.status).toBe('mandate_required');
  });
});

describe('BUY.1 rate', () => {
  it('the 31st create in an hour is 429', async () => {
    const s = await rig.session(B);
    const k = await newAgent(rig.app, B, { mandate: null });
    const seen: number[] = [];
    for (let i = 0; i < 31; i++) seen.push((await post(s, body(k.key_id))).status);
    expect(seen.slice(0, 30)).not.toContain(429);
    expect(seen[30]).toBe(429);
  });
});

describe('BUY.1 route meta (F3)', () => {
  it('create and revoke are buyer, csrf, idempotent, high risk, with the stated limits and bodies', async () => {
    const c = (await import('./app/api/buyer/mandates/route')).routeMeta;
    const r = (await import('./app/api/buyer/mandates/[id]/revoke/route')).routeMeta;
    expect(c).toMatchObject({
      path: '/api/buyer/mandates',
      method: 'POST',
      auth: 'buyer',
      csrf: true,
      idempotent: true,
      risk: 'high',
      max_body_bytes: 4096,
      rate: { name: 'buyer_mandate_create', per: 'actor', limit: 30, window_ms: 3_600_000 },
    });
    expect(r).toMatchObject({
      path: '/api/buyer/mandates/[id]/revoke',
      method: 'POST',
      auth: 'buyer',
      csrf: true,
      idempotent: true,
      risk: 'high',
      max_body_bytes: 1024,
      rate: { name: 'buyer_mandate_revoke', per: 'actor', limit: 60, window_ms: 3_600_000 },
    });
  });
});
