// API-W0 (F2, F3, F4): attacks on the bearer path. No key, malformed key, wrong scope, a key on a route
// of another owner, a cookie next to a key, keys on the operator controls, replay across keys, a
// revoked key, a limiter shared between keys, an agent with a session, and a secret in any output.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Scope } from '@umsbx/contracts';
import { issueKey, parseKeyToken, revokeKey } from './apikey';
import { parseRouteMeta } from './inventory';
import { withRoute, type RouteMeta, type SecurityDeps } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair } from './test-support';
import {
  BUYER_A,
  BUYER_B,
  OPR_MFA,
  OPR_PLAIN,
  PUB_A,
  PUB_B,
  makeV1Rig,
  type V1Rig,
} from './v1-support';
import { dnsMock, expectOffline, netMock, offlineTrace } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

const RATE = { name: 'v1-adv', per: 'actor', limit: 100, window_ms: 60_000 } as const;
const meta = (scopes: readonly Scope[], over: Record<string, unknown> = {}): RouteMeta =>
  ({
    path: '/api/v1/ping',
    method: 'GET',
    auth: 'apikey',
    scopes,
    csrf: false,
    rate: RATE,
    max_body_bytes: 1024,
    idempotent: false,
    risk: 'low',
    ...over,
  }) as RouteMeta;
const Empty = z.object({}).strict();
const Body = z.object({ n: z.number() }).strict();
let handlerRuns = 0;
const ok = async () => {
  handlerRuns += 1;
  return { status: 200 as const, body: { ok: true } };
};
const errCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;
const strip = (body: unknown): unknown => {
  const b = JSON.parse(JSON.stringify(body)) as { error?: { support_code?: string } };
  if (b.error) delete b.error.support_code;
  return b;
};

// Everything the run emits, scanned at the end for a key secret.
const seenSecrets: string[] = [];
const seenOutputs: string[] = [];
const remember = async (rig: V1Rig, res: Response | null, token?: string): Promise<void> => {
  if (token) seenSecrets.push(parseKeyToken(token)?.secret ?? token);
  if (res) seenOutputs.push(await res.clone().text());
  seenOutputs.push(JSON.stringify(rig.log.events), JSON.stringify(rig.audit));
};

describe('authentication', () => {
  it('no Authorization header is 401 and the handler does not run', async () => {
    const rig = await makeV1Rig();
    handlerRuns = 0;
    const res = await withRoute(meta(['catalogue:read']), Empty, ok)(rig.deps)(
      new Request(`${ORIGIN}/api/v1/ping`),
    );
    expect(res.status).toBe(401);
    expect(await errCode(res.clone())).toBe('unauthenticated');
    expect(handlerRuns).toBe(0);
  });

  it('malformed bearer values are all 401 with the same body', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const route = withRoute(meta(['catalogue:read']), Empty, ok)(rig.deps);
    const bodies: unknown[] = [];
    // A trailing space and a NUL cannot be sent: the Fetch API strips or refuses them before we see them.
    const headers = [
      '',
      'Bearer',
      'Bearer ',
      'Bearer umk_',
      `Bearer  ${k.token}`,
      `Bearer ${k.token}x`,
      `Bearer ${k.token.slice(0, -1)}`,
      `Basic ${k.token}`,
      `Token ${k.token}`,
      k.token,
      `Bearer ${k.token}, Bearer ${k.token}`,
      `Bearer ${'A'.repeat(10_000)}`,
      `Bearer ${k.token}\u00e9`,
      `Bearer '; DROP TABLE api_keys; --`,
    ];
    for (const h of headers) {
      const res = await route(
        new Request(`${ORIGIN}/api/v1/ping`, { headers: { authorization: h } }),
      );
      expect(res.status, JSON.stringify(h.slice(0, 40))).toBe(401);
      bodies.push(strip(await res.json()));
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    await remember(rig, null, k.token);
  });

  it('a key in the query string or a header other than Authorization is not accepted', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const route = withRoute(meta(['catalogue:read']), Empty, ok)(rig.deps);
    for (const url of [`/api/v1/ping?access_token=${k.token}`, `/api/v1/ping?key=${k.token}`]) {
      expect((await route(new Request(`${ORIGIN}${url}`))).status, url).toBe(401);
    }
    for (const h of ['x-api-key', 'x-auth-token', 'proxy-authorization']) {
      const res = await route(
        new Request(`${ORIGIN}/api/v1/ping`, { headers: { [h]: `Bearer ${k.token}` } }),
      );
      expect(res.status, h).toBe(401);
    }
  });

  it('unknown id, wrong secret, revoked key and malformed token give the same status and body', async () => {
    const rig = await makeV1Rig();
    const live = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const dead = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    await revokeKey(rig.keyDeps, PUB_A, dead.id);
    const parsed = parseKeyToken(live.token)!;
    const tokens = [
      `umk_${'0'.repeat(26)}_${parsed.secret}`,
      `umk_${parsed.key_id.slice(4)}_${'B'.repeat(43)}`,
      dead.token,
      'umk_garbage',
    ];
    const route = withRoute(meta(['catalogue:read']), Empty, ok)(rig.deps);
    const bodies: unknown[] = [];
    for (const t of tokens) {
      const res = await route(rig.bearer(t));
      expect(res.status).toBe(401);
      bodies.push(strip(await res.json()));
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(JSON.stringify(bodies[0])).not.toMatch(/key_|umk_|revoked|unknown|secret/i);
  });

  it('a cookie named like our session cookie next to a key is 401, even when the cookie is garbage', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const route = withRoute(meta(['catalogue:read']), Empty, ok)(rig.deps);
    const s = await createSession(rig.deps, PUB_A);
    for (const cookie of [
      cookiePair(s.cookie),
      '__Host-ums_s=garbage',
      'a=b; __Host-ums_s=x; c=d',
    ]) {
      const res = await route(rig.bearer(k.token, { headers: { cookie } }));
      expect(res.status, cookie.slice(0, 30)).toBe(401);
    }
    // an unrelated cookie does not matter
    expect((await route(rig.bearer(k.token, { headers: { cookie: 'theme=dark' } }))).status).toBe(
      200,
    );
  });

  it('a bearer key on a session route is ignored: no session, no access', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    const sessionMeta: RouteMeta = {
      path: '/api/orders/x',
      method: 'GET',
      auth: 'buyer',
      csrf: false,
      rate: null,
      max_body_bytes: 10,
      idempotent: false,
      risk: 'low',
    };
    handlerRuns = 0;
    const res = await withRoute(sessionMeta, Empty, ok)(rig.deps)(
      rig.bearer(k.token, { url: '/api/orders/x' }),
    );
    expect(res.status).toBe(401);
    expect(handlerRuns).toBe(0);
  });

  it('a bearer header on a /api/v1 session route is refused even with a good session', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    const s = await createSession(rig.deps, BUYER_A);
    const route = withRoute(
      meta([], {
        auth: 'owner',
        scopes: undefined,
        path: '/api/v1/api-keys',
        rate: null,
      }) as RouteMeta,
      Empty,
      ok,
    )(rig.deps);
    const withBearer = await route(
      new Request(`${ORIGIN}/api/v1/api-keys`, {
        headers: { cookie: cookiePair(s.cookie), authorization: `Bearer ${k.token}` },
      }),
    );
    expect(withBearer.status).toBe(401);
    const plain = await route(
      new Request(`${ORIGIN}/api/v1/api-keys`, { headers: { cookie: cookiePair(s.cookie) } }),
    );
    expect(plain.status).toBe(200);
  });
});

describe('scopes and owners', () => {
  it('an agent key on a publisher route is 403', async () => {
    const rig = await makeV1Rig();
    const agent = await rig.issue(BUYER_A, 'agent', ['agent:buy', 'catalogue:read']);
    handlerRuns = 0;
    const res = await withRoute(meta(['offers:write'], { method: 'GET' }), Empty, ok)(rig.deps)(
      rig.bearer(agent.token),
    );
    expect(res.status).toBe(403);
    expect(handlerRuns).toBe(0);
  });

  it('a buyer key on a publisher route and a publisher key on a buyer route are 403', async () => {
    const rig = await makeV1Rig();
    const buyerKey = await rig.issue(BUYER_A, 'api_client', ['orders:read', 'orders:write']);
    const pubKey = await rig.issue(PUB_A, 'api_client', ['sales:read']);
    expect(
      (await withRoute(meta(['sales:read']), Empty, ok)(rig.deps)(rig.bearer(buyerKey.token)))
        .status,
    ).toBe(403);
    expect(
      (await withRoute(meta(['orders:read']), Empty, ok)(rig.deps)(rig.bearer(pubKey.token)))
        .status,
    ).toBe(403);
  });

  it('a scope written straight into the table beyond the matrix does not reach a route', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    await rig.db.query(
      `UPDATE api_keys SET scopes = ARRAY['orders:read','ops:read','agent:buy']::text[] WHERE id = $1`,
      [k.id],
    );
    for (const s of ['ops:read', 'agent:buy'] as Scope[]) {
      expect((await withRoute(meta([s]), Empty, ok)(rig.deps)(rig.bearer(k.token))).status, s).toBe(
        403,
      );
    }
  });

  it('issue refuses a scope outside the matrix: a buyer asking for ops:read or ops:write, a publisher for agent:buy', async () => {
    const rig = await makeV1Rig();
    expect(
      await issueKey(rig.keyDeps, {
        owner: BUYER_A,
        key_kind: 'api_client',
        scopes: ['ops:write'],
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_scopes',
    });
    expect(
      await issueKey(rig.keyDeps, { owner: BUYER_A, key_kind: 'api_client', scopes: ['ops:read'] }),
    ).toEqual({
      ok: false,
      error: 'scope_not_allowed',
    });
    expect(
      await issueKey(rig.keyDeps, { owner: PUB_A, key_kind: 'api_client', scopes: ['agent:buy'] }),
    ).toEqual({
      ok: false,
      error: 'scope_not_allowed',
    });
  });

  it('an operator scope is not issued to a session without a second factor', async () => {
    const rig = await makeV1Rig();
    expect(
      await issueKey(rig.keyDeps, {
        owner: OPR_PLAIN,
        key_kind: 'api_client',
        scopes: ['ops:read'],
      }),
    ).toEqual({
      ok: false,
      error: 'mfa_required',
    });
    expect(
      (
        await issueKey(rig.keyDeps, {
          owner: OPR_MFA,
          key_kind: 'api_client',
          scopes: ['ops:read'],
        })
      ).ok,
    ).toBe(true);
  });
});

describe('a key never reaches the operator controls', () => {
  const API = fileURLToPath(new URL('../../../apps/web/src/app/api/', import.meta.url));
  const routeFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = `${dir}${n}`;
      return statSync(p).isDirectory() ? routeFiles(`${p}/`) : n === 'route.ts' ? [p] : [];
    });

  it('no existing route outside /api/v1 accepts a key, and no /api/ops route does at all', () => {
    const files = routeFiles(API);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = f.slice(API.length - '/api/'.length);
      const m = parseRouteMeta(src);
      if (rel.startsWith('/api/v1/')) continue;
      expect(m?.auth, rel).not.toBe('apikey');
      expect(src, rel).not.toMatch(/auth:\s*['"]apikey['"]/);
    }
    expect(files.some((f) => f.includes('/ops/stop/'))).toBe(true);
    expect(files.some((f) => f.includes('/ops/start/'))).toBe(true);
  });

  it('a valid operator key sent to the real stop and start route metas is 401 and the handler does not run', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    for (const name of ['stop', 'start']) {
      const m = parseRouteMeta(readFileSync(`${API}ops/${name}/route.ts`, 'utf8'))!;
      expect(m.auth).toBe('operator');
      handlerRuns = 0;
      const res = await withRoute(
        { ...m, scopes: undefined } as RouteMeta,
        z.object({}).passthrough(),
        ok,
      )(rig.deps)(
        rig.bearer(k.token, {
          method: 'POST',
          url: `/api/ops/${name}`,
          body: {},
          headers: { origin: ORIGIN, 'idempotency-key': 'op-key-000001' },
        }),
      );
      expect(res.status, name).toBe(401);
      expect(handlerRuns).toBe(0);
    }
  });

  it('a bearer-only request to every /api/ops route meta is refused, whatever the key', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    for (const f of routeFiles(`${API}ops/`)) {
      const m = parseRouteMeta(readFileSync(f, 'utf8'));
      if (!m || m.path === undefined || m.method === undefined) continue;
      const res = await withRoute(
        { ...m, scopes: undefined } as RouteMeta,
        z.object({}).passthrough(),
        ok,
      )(rig.deps)(
        rig.bearer(k.token, {
          method: m.method,
          url: m.path.replace(/\[[^\]]+\]/g, 'x'),
          body: m.method === 'GET' ? undefined : {},
          headers: { origin: ORIGIN },
        }),
      );
      expect(res.status, m.path).toBe(401);
    }
  });
});

describe('an operator key never changes state', () => {
  it('an operator key with ops:read on a POST, PATCH or DELETE apikey route is 403 mfa_required and the handler does not run', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      handlerRuns = 0;
      const res = await withRoute(
        meta(['ops:read'], { method, path: '/api/v1/ops-thing', idempotent: true }),
        z.object({}).passthrough(),
        ok,
      )(rig.deps)(
        rig.bearer(k.token, {
          method,
          url: '/api/v1/ops-thing',
          body: {},
          headers: { 'idempotency-key': `op-change-${method}-000001` },
        }),
      );
      expect(res.status, method).toBe(403);
      expect(await errCode(res), method).toBe('mfa_required');
      expect(handlerRuns, method).toBe(0);
    }
  });

  it('the same operator key still reads (GET 200), and a buyer key still writes', async () => {
    const rig = await makeV1Rig();
    const op = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    handlerRuns = 0;
    const read = await withRoute(meta(['ops:read']), Empty, ok)(rig.deps)(
      rig.bearer(op.token, { method: 'GET', url: '/api/v1/ping' }),
    );
    expect(read.status).toBe(200);
    const buyer = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const write = await withRoute(
      meta(['orders:write'], { method: 'POST', path: '/api/v1/things', idempotent: true }),
      Body,
      ok,
    )(rig.deps)(
      rig.bearer(buyer.token, {
        method: 'POST',
        url: '/api/v1/things',
        body: { n: 1 },
        headers: { 'idempotency-key': 'buyer-write-000001' },
      }),
    );
    expect(write.status).toBe(200);
    expect(handlerRuns).toBe(2);
  });
});

describe('keys cannot use each other', () => {
  it("key A's Idempotency-Key cannot replay key B's stored answer", async () => {
    const rig = await makeV1Rig();
    const a = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const b = await rig.issue(BUYER_B, 'api_client', ['orders:write']);
    let n = 0;
    const route = withRoute(
      meta(['orders:write'], { method: 'POST', path: '/api/v1/things', idempotent: true }),
      Body,
      async (ctx) => {
        n += 1;
        return {
          status: 201 as const,
          body: { run: n, who: ctx.actor.kind === 'buyer' ? ctx.actor.buyer_id : '?' },
        };
      },
    )(rig.deps);
    const post = (token: string) =>
      route(
        rig.bearer(token, {
          method: 'POST',
          url: '/api/v1/things',
          body: { n: 1 },
          headers: { 'idempotency-key': 'shared-key-0001' },
        }),
      );
    const first = await post(a.token);
    const other = await post(b.token);
    expect(other.headers.get('idempotent-replay')).toBeNull();
    expect(((await other.json()) as { who: string }).who).toBe('buy_w0b');
    expect(((await first.json()) as { who: string }).who).toBe('buy_w0a');
    expect(n).toBe(2);
    // and each key still replays its own
    expect((await post(a.token)).headers.get('idempotent-replay')).toBe('true');
    expect(n).toBe(2);
  });

  it("key A's rate limit leaves key B alone, including two keys of the same owner", async () => {
    const rig = await makeV1Rig();
    const a = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const b = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const c = await rig.issue(PUB_B, 'api_client', ['catalogue:read']);
    const route = withRoute(
      meta(['catalogue:read'], { rate: { ...RATE, name: 'v1-three', limit: 3 } }),
      Empty,
      ok,
    )(rig.deps);
    for (let i = 0; i < 3; i++) expect((await route(rig.bearer(a.token))).status).toBe(200);
    expect((await route(rig.bearer(a.token))).status).toBe(429);
    expect((await route(rig.bearer(b.token))).status).toBe(200);
    expect((await route(rig.bearer(c.token))).status).toBe(200);
  });

  it('a key at 429 cannot be revived by sending a different bearer spelling', async () => {
    const rig = await makeV1Rig();
    const a = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const route = withRoute(
      meta(['catalogue:read'], { rate: { ...RATE, name: 'v1-one', limit: 1 } }),
      Empty,
      ok,
    )(rig.deps);
    await route(rig.bearer(a.token));
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const res = await route(
        new Request(`${ORIGIN}/api/v1/ping`, {
          headers: { authorization: `${scheme} ${a.token}` },
        }),
      );
      expect(res.status, scheme).toBe(429);
    }
  });

  it("a revoked key's retry with the same Idempotency-Key is refused, not replayed", async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let n = 0;
    const route = withRoute(
      meta(['orders:write'], { method: 'POST', path: '/api/v1/things', idempotent: true }),
      Body,
      async () => {
        n += 1;
        return { status: 201 as const, body: { n } };
      },
    )(rig.deps);
    const send = () =>
      route(
        rig.bearer(k.token, {
          method: 'POST',
          url: '/api/v1/things',
          body: { n: 1 },
          headers: { 'idempotency-key': 'revoke-key-0001' },
        }),
      );
    expect((await send()).status).toBe(201);
    await revokeKey(rig.keyDeps, BUYER_A, k.id);
    const retry = await send();
    expect(retry.status).toBe(401);
    expect(retry.headers.get('idempotent-replay')).toBeNull();
    expect(n).toBe(1);
  });

  it('a missing Idempotency-Key on a bearer POST is 400 and nothing runs', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    handlerRuns = 0;
    const res = await withRoute(
      meta(['orders:write'], { method: 'POST', path: '/api/v1/things', idempotent: true }),
      Body,
      ok,
    )(rig.deps)(rig.bearer(k.token, { method: 'POST', url: '/api/v1/things', body: { n: 1 } }));
    expect(res.status).toBe(400);
    expect(handlerRuns).toBe(0);
  });

  it('a body past the cap is 413 before the key is even looked up', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const res = await withRoute(
      meta(['orders:write'], {
        method: 'POST',
        path: '/api/v1/things',
        idempotent: true,
        max_body_bytes: 8,
      }),
      Body,
      ok,
    )(rig.deps)(
      rig.bearer(k.token, {
        method: 'POST',
        url: '/api/v1/things',
        body: { n: 1111111111 },
        headers: { 'idempotency-key': 'big-body-00001', 'content-length': '100' },
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe('an agent cannot hold a session', () => {
  it('createSession refuses a principal and a made-up kind, and stores nothing', async () => {
    const rig = await makeV1Rig();
    const before = await rig.db.query<{ n: number | string }>('SELECT count(*) AS n FROM sessions');
    for (const bad of [
      { kind: 'agent', key_id: 'key_1', buyer_id: 'buy_w0a', mandate_id: null },
      { kind: 'api_client', key_id: 'key_1', owner: PUB_A },
      { kind: 'admin' },
    ]) {
      await expect(createSession(rig.deps, bad as never), bad.kind).rejects.toThrow();
    }
    const after = await rig.db.query<{ n: number | string }>('SELECT count(*) AS n FROM sessions');
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
  });

  it('the sessions table refuses actor_kind agent', async () => {
    const rig = await makeV1Rig();
    const stamp = rig.clock.now().toISOString();
    await expect(
      rig.db.query(
        `INSERT INTO sessions (id, actor_kind, actor_id, csrf_token_hash, last_seen_at, expires_at, revoked_at, created_at, updated_at)
         VALUES ('ses_x', 'agent', 'buy_w0a', $1, $2, $2, NULL, $2, $2)`,
        ['a'.repeat(64), stamp],
      ),
    ).rejects.toThrow();
  });
});

describe('nothing leaks', () => {
  it('no log line, audit row or response of this file holds a key secret or a token', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'agent', ['catalogue:read']);
    const route = withRoute(meta(['catalogue:read']), Empty, ok)(rig.deps);
    const good = await route(rig.bearer(k.token));
    const bad = await route(rig.bearer(`${k.token}x`));
    const denied = await withRoute(meta(['sales:read']), Empty, ok)(rig.deps)(rig.bearer(k.token));
    for (const r of [good, bad, denied]) await remember(rig, r, k.token);
    const all = seenOutputs.join('\n');
    expect(all).not.toContain('umk_');
    for (const secret of seenSecrets) expect(all).not.toContain(secret);
  });

  it('a deps log sink that captures everything still holds no token after a refused call', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const deps: SecurityDeps = { ...rig.deps };
    await withRoute(meta(['catalogue:read']), Empty, async () => {
      throw new Error(`explode ${'x'}`);
    })(deps)(rig.bearer(k.token));
    expect(JSON.stringify(rig.log.events)).not.toContain(parseKeyToken(k.token)!.secret);
    expect(JSON.stringify(rig.log.events)).not.toContain('umk_');
  });
});

describe('the offline guard is watching', () => {
  it('a network call through the guard is recorded and refused (canary), then the record is cleared', () => {
    // The factories are the ones the vi.mock lines above install for node:net and node:dns, so this calls
    // the same refusing functions without opening a socket or naming a network client here.
    const real = () => 'would connect';
    const net = netMock({ connect: real, default: { connect: real } }) as {
      connect: () => unknown;
      default: { connect: () => unknown };
    };
    const dns = dnsMock({ lookup: real, default: { lookup: real } }) as {
      lookup: () => unknown;
      default: { lookup: () => unknown };
    };
    expect(() => net.connect()).toThrow(/offline/);
    expect(() => net.default.connect()).toThrow(/offline/);
    expect(() => dns.lookup()).toThrow(/offline/);
    expect(offlineTrace.calls.length).toBe(3);
    offlineTrace.calls.length = 0;
  });
});
