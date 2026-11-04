// API-W0 (F4): route wrapper v2 on a real PGlite database. Bearer auth, scopes, the principal mapped to
// a domain actor, Idempotency-Key on every non-GET v1 route, a rate bucket per key, PATCH and DELETE,
// and the wrapper's own audit row. Attacks are in route-v2.adversarial.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal, Scope } from '@umsbx/contracts';
import { withRoute, type RouteMeta, type SecurityDeps } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair } from './test-support';
import { BUYER_A, OPR_MFA, PUB_A, makeV1Rig } from './v1-support';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

const RATE = { name: 'v1-test', per: 'actor', limit: 100, window_ms: 60_000 } as const;
const base = {
  csrf: false,
  rate: RATE,
  max_body_bytes: 1024,
  risk: 'low',
} as const;
const getMeta = (
  scopes: readonly Scope[] = ['catalogue:read'],
  path = '/api/v1/ping',
): RouteMeta => ({
  ...base,
  path,
  method: 'GET',
  auth: 'apikey',
  scopes,
  idempotent: false,
});
const postMeta = (scopes: readonly Scope[] = ['orders:write']): RouteMeta => ({
  ...base,
  path: '/api/v1/things',
  method: 'POST',
  auth: 'apikey',
  scopes,
  idempotent: true,
});
const patchMeta: RouteMeta = { ...postMeta(), path: '/api/v1/things/[id]', method: 'PATCH' };
const deleteMeta: RouteMeta = { ...postMeta(), path: '/api/v1/things/[id]', method: 'DELETE' };

const Empty = z.object({}).strict();
const Q = z.object({ q: z.string().optional() }).strict();
const Body = z.object({ n: z.number() }).strict();
const BodyId = z.object({ n: z.number(), id: z.string() }).strict();
const Id = z.object({ id: z.string() }).strict();

interface Seen {
  actor: unknown;
  principal: Principal | null;
  input: unknown;
}

const echo =
  (seen: Seen[] = []) =>
  async (ctx: { actor: unknown; principal: Principal | null; input: unknown }) => {
    seen.push({ actor: ctx.actor, principal: ctx.principal, input: ctx.input });
    return {
      status: 200 as const,
      body: { actor: ctx.actor, principal: ctx.principal, input: ctx.input },
    };
  };

describe('validateMeta for bearer routes', () => {
  const build = (m: Partial<RouteMeta> & Record<string, unknown>) => () =>
    withRoute({ ...getMeta(), ...m } as RouteMeta, Empty, echo());

  it('accepts a well-formed apikey route', () => {
    expect(build({})).not.toThrow();
    expect(() => withRoute(postMeta(), Body, echo())).not.toThrow();
    expect(() => withRoute(patchMeta, BodyId, echo())).not.toThrow();
    expect(() => withRoute(deleteMeta, Id, echo())).not.toThrow();
  });

  it('refuses a path outside /api/v1', () => {
    expect(build({ path: '/api/things' })).toThrow(/invalid RouteMeta/);
    expect(build({ path: '/api/v10/x' })).toThrow(/invalid RouteMeta/);
  });

  it('refuses csrf on a bearer route, a missing or empty scope list and an unknown scope', () => {
    expect(build({ csrf: true })).toThrow(/invalid RouteMeta/);
    expect(build({ scopes: undefined })).toThrow(/invalid RouteMeta/);
    expect(build({ scopes: [] })).toThrow(/invalid RouteMeta/);
    expect(build({ scopes: ['ops:write'] as never })).toThrow(/invalid RouteMeta/);
  });

  it('needs a rate rule per actor (the key id) on a bearer route', () => {
    expect(build({ rate: null })).toThrow(/invalid RouteMeta/);
    expect(build({ rate: { ...RATE, per: 'ip' } })).toThrow(/invalid RouteMeta/);
  });

  it('needs an Idempotency-Key on every non-GET bearer route and none on GET', () => {
    expect(() => withRoute({ ...postMeta(), idempotent: false }, Body, echo())).toThrow(
      /invalid RouteMeta/,
    );
    expect(() => withRoute({ ...deleteMeta, idempotent: false }, Id, echo())).toThrow(
      /invalid RouteMeta/,
    );
    expect(build({ idempotent: true })).toThrow(/invalid RouteMeta/);
  });

  it('a session route under /api/v1 that changes state also needs idempotent: true and csrf', () => {
    const session = (m: Record<string, unknown>) =>
      withRoute(
        {
          path: '/api/v1/api-keys',
          method: 'POST',
          auth: 'owner',
          csrf: true,
          rate: null,
          max_body_bytes: 1024,
          idempotent: true,
          risk: 'high',
          ...m,
        } as RouteMeta,
        Body,
        echo(),
      );
    expect(() => session({})).not.toThrow();
    expect(() => session({ idempotent: false })).toThrow(/invalid RouteMeta/);
    expect(() => session({ csrf: false })).toThrow(/invalid RouteMeta/);
    expect(() => session({ method: 'DELETE', csrf: false })).toThrow(/invalid RouteMeta/);
    expect(() => session({ scopes: ['catalogue:read'] })).toThrow(/invalid RouteMeta/);
  });

  it('scopes are not allowed on a session route outside the apikey rule', () => {
    expect(() =>
      withRoute(
        {
          path: '/api/orders',
          method: 'POST',
          auth: 'buyer',
          csrf: true,
          rate: null,
          max_body_bytes: 10,
          idempotent: true,
          risk: 'low',
          scopes: ['orders:read'],
        } as RouteMeta,
        Body,
        echo(),
      ),
    ).toThrow(/invalid RouteMeta/);
  });
});

describe('a bearer GET', () => {
  it('runs the handler with the principal, and ctx.actor is the mapped domain actor', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const seen: Seen[] = [];
    const res = await withRoute(getMeta(), Q, echo(seen))(rig.deps)(
      rig.bearer(k.token, { url: '/api/v1/ping?q=x' }),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.actor).toEqual(PUB_A);
    expect(seen[0]!.principal).toEqual({ kind: 'api_client', key_id: k.id, owner: PUB_A });
    expect(seen[0]!.input).toEqual({ q: 'x' });
  });

  it('maps an agent to its buyer and an operator key to an operator without a second factor', async () => {
    const rig = await makeV1Rig();
    const agent = await rig.issue(BUYER_A, 'agent', ['catalogue:read']);
    const opr = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    const seen: Seen[] = [];
    await withRoute(getMeta(['catalogue:read']), Empty, echo(seen))(rig.deps)(
      rig.bearer(agent.token),
    );
    await withRoute(getMeta(['ops:read']), Empty, echo(seen))(rig.deps)(rig.bearer(opr.token));
    expect(seen[0]!.actor).toEqual(BUYER_A);
    expect(seen[0]!.principal).toMatchObject({
      kind: 'agent',
      buyer_id: 'buy_w0a',
      mandate_id: null,
    });
    expect(seen[1]!.actor).toEqual({ kind: 'operator', operator_id: 'opr_w0', mfa: false });
  });

  it('needs no CSRF token, no origin and no cookie', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const res = await withRoute(getMeta(), Empty, echo())(rig.deps)(rig.bearer(k.token));
    expect(res.status).toBe(200);
  });

  it('carries the security headers and a request id like every other route', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const res = await withRoute(getMeta(), Empty, echo())(rig.deps)(rig.bearer(k.token));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a wrong method on the route is a 404 before any key lookup', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const res = await withRoute(getMeta(), Empty, echo())(rig.deps)(
      rig.bearer(k.token, { method: 'POST', body: {} }),
    );
    expect(res.status).toBe(404);
  });
});

describe('scopes', () => {
  it('a key that holds every required scope passes, a key missing one gets 403 and the handler does not run', async () => {
    const rig = await makeV1Rig();
    const both = await rig.issue(BUYER_A, 'api_client', ['orders:read', 'orders:write']);
    const one = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    const seen: Seen[] = [];
    const route = withRoute(getMeta(['orders:read', 'orders:write']), Empty, echo(seen))(rig.deps);
    expect((await route(rig.bearer(both.token))).status).toBe(200);
    const denied = await route(rig.bearer(one.token));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    expect(seen).toHaveLength(1);
  });
});

describe('Idempotency-Key on non-GET v1 routes', () => {
  const post = (
    rig: Awaited<ReturnType<typeof makeV1Rig>>,
    token: string,
    body: unknown,
    key: string | null,
  ) =>
    rig.bearer(token, {
      method: 'POST',
      url: '/api/v1/things',
      body,
      headers: key === null ? {} : { 'idempotency-key': key },
    });

  it('the same key and body returns the stored answer and runs the handler once', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let runs = 0;
    const route = withRoute(postMeta(), Body, async (ctx) => {
      runs += 1;
      return { status: 201 as const, body: { created: runs, n: ctx.input.n } };
    })(rig.deps);
    const first = await route(post(rig, k.token, { n: 1 }, 'key-0001-abcdef'));
    const second = await route(post(rig, k.token, { n: 1 }, 'key-0001-abcdef'));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(runs).toBe(1);
  });

  it('the same key with a different body is 409 idempotency_key_reused', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const route = withRoute(postMeta(), Body, async () => ({ status: 201 as const, body: {} }))(
      rig.deps,
    );
    await route(post(rig, k.token, { n: 1 }, 'key-0001-abcdef'));
    const res = await route(post(rig, k.token, { n: 2 }, 'key-0001-abcdef'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'idempotency_key_reused',
    );
  });

  it('a missing or malformed key is 400 and the handler does not run', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let runs = 0;
    const route = withRoute(postMeta(), Body, async () => {
      runs += 1;
      return { status: 201 as const, body: {} };
    })(rig.deps);
    for (const key of [null, '', 'short', 'has space in it!', 'x'.repeat(129)]) {
      const res = await route(post(rig, k.token, { n: 1 }, key));
      expect(res.status, String(key)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'idempotency_key',
      );
    }
    expect(runs).toBe(0);
  });

  it('the reservation is scoped to the key id: api_idempotency holds actor_kind key', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const route = withRoute(postMeta(), Body, async () => ({ status: 201 as const, body: {} }))(
      rig.deps,
    );
    await route(post(rig, k.token, { n: 1 }, 'key-0001-abcdef'));
    const rows = await rig.db.query<{ actor_kind: string; actor_id: string }>(
      'SELECT actor_kind, actor_id FROM api_idempotency',
    );
    expect(rows.rows).toEqual([{ actor_kind: 'key', actor_id: k.id }]);
  });

  it('a refusal from the handler clears the reservation so the client may retry', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let runs = 0;
    const route = withRoute(postMeta(), Body, async () => {
      runs += 1;
      return runs === 1
        ? { status: 409 as const, code: 'busy', message: 'Try again.' }
        : { status: 201 as const, body: { ok: true } };
    })(rig.deps);
    expect((await route(post(rig, k.token, { n: 1 }, 'key-0001-abcdef'))).status).toBe(409);
    expect((await route(post(rig, k.token, { n: 1 }, 'key-0001-abcdef'))).status).toBe(201);
  });
});

describe('PATCH and DELETE', () => {
  it('PATCH reads the JSON body and the path params, and DELETE reads the path params', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const seen: Seen[] = [];
    const patch = withRoute(patchMeta, BodyId, echo(seen))(rig.deps);
    const del = withRoute(deleteMeta, Id, echo(seen))(rig.deps);
    const p = await patch(
      rig.bearer(k.token, {
        method: 'PATCH',
        url: '/api/v1/things/t1',
        body: { n: 3 },
        headers: { 'idempotency-key': 'patch-key-0001' },
      }),
      { params: { id: 't1' } },
    );
    const d = await del(
      rig.bearer(k.token, {
        method: 'DELETE',
        url: '/api/v1/things/t1',
        headers: { 'idempotency-key': 'delete-key-0001' },
      }),
      { params: { id: 't1' } },
    );
    expect(p.status).toBe(200);
    expect(d.status).toBe(200);
    expect(seen[0]!.input).toEqual({ n: 3, id: 't1' });
    expect(seen[1]!.input).toEqual({ id: 't1' });
  });

  it('a verb that does not match the route is a 404', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const del = withRoute(deleteMeta, Id, echo())(rig.deps);
    const res = await del(
      rig.bearer(k.token, {
        method: 'PATCH',
        url: '/api/v1/things/t1',
        body: {},
        headers: { 'idempotency-key': 'patch-key-0002' },
      }),
      { params: { id: 't1' } },
    );
    expect(res.status).toBe(404);
  });

  it('DELETE replays by key and path: the same key on another id is a different request', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let runs = 0;
    const del = withRoute(deleteMeta, Id, async () => {
      runs += 1;
      return { status: 200 as const, body: { runs } };
    })(rig.deps);
    const call = (id: string) =>
      del(
        rig.bearer(k.token, {
          method: 'DELETE',
          url: `/api/v1/things/${id}`,
          headers: { 'idempotency-key': 'same-key-0001' },
        }),
        { params: { id } },
      );
    expect((await call('a')).status).toBe(200);
    expect((await call('a')).headers.get('idempotent-replay')).toBe('true');
    expect((await call('b')).status).toBe(409);
    expect(runs).toBe(1);
  });
});

describe('rate limit per key', () => {
  it('limits each key on its own bucket', async () => {
    const rig = await makeV1Rig();
    const a = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const b = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const meta: RouteMeta = { ...getMeta(), rate: { ...RATE, name: 'v1-two', limit: 2 } };
    const route = withRoute(meta, Empty, echo())(rig.deps);
    expect((await route(rig.bearer(a.token))).status).toBe(200);
    expect((await route(rig.bearer(a.token))).status).toBe(200);
    const limited = await route(rig.bearer(a.token));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await route(rig.bearer(b.token))).status).toBe(200);
    rig.clock.advance(60_000);
    expect((await route(rig.bearer(a.token))).status).toBe(200);
  });
});

describe('the wrapper audit row', () => {
  it('records api.request with the mapped actor and the key, and no token', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'agent', ['catalogue:read']);
    await withRoute(getMeta(), Empty, echo())(rig.deps)(rig.bearer(k.token));
    const rows = rig.auditOf('api.request');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toEqual(BUYER_A);
    expect(rows[0]!.target).toBeNull();
    expect(rows[0]!.detail).toEqual({
      via_kind: 'agent',
      via_key_id: k.id,
      route: '/api/v1/ping',
      method: 'GET',
      status: 200,
    });
    expect(JSON.stringify(rig.audit)).not.toContain('umk_');
  });

  it('an api_client row names kind api_client and the owner actor kind', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    await withRoute(getMeta(), Empty, echo())(rig.deps)(rig.bearer(k.token));
    const [row] = rig.auditOf('api.request');
    expect(row!.actor.kind).toBe('publisher');
    expect(row!.detail['via_kind']).toBe('api_client');
    expect(row!.detail['via_key_id']).toBe(k.id);
  });

  it('a scope refusal, a success and a rate limit are audited with their status', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write', 'catalogue:read']);
    const route403 = withRoute(getMeta(['sales:read']), Empty, echo())(rig.deps);
    await route403(rig.bearer(k.token));
    const limited = withRoute(
      { ...getMeta(), rate: { ...RATE, name: 'v1-one', limit: 1 } },
      Empty,
      echo(),
    )(rig.deps);
    await limited(rig.bearer(k.token));
    await limited(rig.bearer(k.token));
    const statuses = rig.auditOf('api.request').map((r) => r.detail['status']);
    expect(statuses).toEqual([403, 200, 429]);
  });

  it('a handler that throws answers 500 and the row says 500', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const res = await withRoute(getMeta(), Empty, async () => {
      throw new Error('boom');
    })(rig.deps)(rig.bearer(k.token));
    expect(res.status).toBe(500);
    expect(rig.auditOf('api.request')[0]!.detail['status']).toBe(500);
  });

  it('a request that fails authentication writes no api.request row (there is no key to name)', async () => {
    const rig = await makeV1Rig();
    await withRoute(getMeta(), Empty, echo())(rig.deps)(rig.bearer('umk_nonsense'));
    expect(rig.auditOf('api.request')).toEqual([]);
  });

  it('a failing audit sink never changes the answer, and the failure is logged without the key', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const deps: SecurityDeps = {
      ...rig.deps,
      audit: {
        async record() {
          throw new Error('audit down');
        },
      },
    };
    const res = await withRoute(getMeta(), Empty, echo())(deps)(rig.bearer(k.token));
    expect(res.status).toBe(200);
    expect(rig.log.events.some((e) => e.msg === 'audit_error')).toBe(true);
    expect(JSON.stringify(rig.log.events)).not.toContain(k.token);
  });

  it('domain code and session routes are untouched: a session request writes no api.request row', async () => {
    const rig = await makeV1Rig();
    const s = await createSession(rig.deps, BUYER_A);
    const meta: RouteMeta = {
      path: '/api/orders/x',
      method: 'GET',
      auth: 'buyer',
      csrf: false,
      rate: null,
      max_body_bytes: 10,
      idempotent: false,
      risk: 'low',
    };
    const seen: Seen[] = [];
    const res = await withRoute(meta, Empty, echo(seen))(rig.deps)(
      new Request(`${ORIGIN}/api/orders/x`, { headers: { cookie: cookiePair(s.cookie) } }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]!.principal).toBeNull();
    expect(rig.auditOf('api.request')).toEqual([]);
  });
});

describe('session routes under /api/v1', () => {
  const sessionMeta = (over: Record<string, unknown> = {}): RouteMeta =>
    ({
      path: '/api/v1/api-keys',
      method: 'POST',
      auth: 'owner',
      csrf: true,
      rate: null,
      max_body_bytes: 1024,
      idempotent: true,
      risk: 'high',
      ...over,
    }) as RouteMeta;

  it('auth owner accepts a buyer, a publisher and an operator session, each mapped to itself', async () => {
    const rig = await makeV1Rig();
    for (const actor of [BUYER_A, PUB_A, OPR_MFA]) {
      const s = await createSession(rig.deps, actor);
      const seen: Seen[] = [];
      const res = await withRoute(sessionMeta(), Body, echo(seen))(rig.deps)(
        new Request(`${ORIGIN}/api/v1/api-keys`, {
          method: 'POST',
          headers: {
            cookie: cookiePair(s.cookie),
            origin: ORIGIN,
            'x-csrf-token': s.csrf_token,
            'idempotency-key': `key-${actor.kind}-0001`,
          },
          body: JSON.stringify({ n: 1 }),
        }),
      );
      expect(res.status, actor.kind).toBe(200);
      expect(seen[0]!.actor).toEqual(actor);
      expect(seen[0]!.principal).toBeNull();
    }
  });

  it('auth owner refuses a request with no session (401)', async () => {
    const rig = await makeV1Rig();
    const res = await withRoute(sessionMeta(), Body, echo())(rig.deps)(
      new Request(`${ORIGIN}/api/v1/api-keys`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'idempotency-key': 'key-nosession-01' },
        body: '{"n":1}',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('a DELETE needs the CSRF token like a POST', async () => {
    const rig = await makeV1Rig();
    const s = await createSession(rig.deps, BUYER_A);
    const route = withRoute(
      sessionMeta({ path: '/api/v1/api-keys/[id]', method: 'DELETE' }),
      Id,
      echo(),
    )(rig.deps);
    const req = (csrf: string | null) =>
      new Request(`${ORIGIN}/api/v1/api-keys/k1`, {
        method: 'DELETE',
        headers: {
          cookie: cookiePair(s.cookie),
          origin: ORIGIN,
          'idempotency-key': 'delete-csrf-0001',
          ...(csrf === null ? {} : { 'x-csrf-token': csrf }),
        },
      });
    expect((await route(req(null), { params: { id: 'k1' } })).status).toBe(403);
    expect((await route(req(s.csrf_token), { params: { id: 'k1' } })).status).toBe(200);
  });

  it('a missing Idempotency-Key is 400 on /api/v1 session routes (existing routes keep 422)', async () => {
    const rig = await makeV1Rig();
    const s = await createSession(rig.deps, BUYER_A);
    const res = await withRoute(sessionMeta(), Body, echo())(rig.deps)(
      new Request(`${ORIGIN}/api/v1/api-keys`, {
        method: 'POST',
        headers: { cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token },
        body: '{"n":1}',
      }),
    );
    expect(res.status).toBe(400);
    const old = await withRoute({ ...sessionMeta(), path: '/api/orders' }, Body, echo())(rig.deps)(
      new Request(`${ORIGIN}/api/orders`, {
        method: 'POST',
        headers: { cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token },
        body: '{"n":1}',
      }),
    );
    expect(old.status).toBe(422);
  });
});

describe('maintenance mode', () => {
  it('answers 503 for a bearer route before it looks at the key', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const res = await withRoute(getMeta(), Empty, echo())({ ...rig.deps, maintenance: true })(
      rig.bearer(k.token),
    );
    expect(res.status).toBe(503);
    const [view] = await rig.db
      .query<{ last_used_at: unknown }>('SELECT last_used_at FROM api_keys WHERE id = $1', [k.id])
      .then((r) => r.rows);
    expect(view!.last_used_at).toBeNull();
  });
});
