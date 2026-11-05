// INT-CTL / CTL.5: the exposure reader and its place in withRoute. A disabled group answers 403 api_disabled for
// a verified bearer key and for nothing else; the read is cached for at most 5 seconds on the injected clock;
// a failed read closes every group (fail closed); a missing reader means every group is enabled (F5).
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApiGroup, ExposureReader } from '@umsbx/contracts';
import { createExposureReader } from './exposure';
import { withRoute } from './route';
import type { RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';
import { BUYER_A, OPR_MFA, makeV1Rig } from './v1-support';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

const off = (g: ApiGroup): ExposureReader => ({ isEnabled: async (x) => x !== g });
const Empty = z.object({}).strict();
const Body = z.object({ n: z.number() }).strict();
const base = { csrf: false, max_body_bytes: 1024, risk: 'low' } as const;
const RATE = { name: 'exp-test', per: 'actor', limit: 100, window_ms: 60_000 } as const;
const getOrders: RouteMeta = {
  ...base,
  rate: RATE,
  path: '/api/v1/orders',
  method: 'GET',
  auth: 'apikey',
  scopes: ['orders:read'],
  idempotent: false,
};
const postOrders: RouteMeta = {
  ...getOrders,
  method: 'POST',
  scopes: ['orders:write'],
  idempotent: true,
};
const ok = async () => ({ status: 200 as const, body: { ran: true } });
const codeOf = async (r: Response): Promise<string> =>
  ((await r.json()) as { error: { code: string } }).error.code;

describe('createExposureReader', () => {
  it('reads the seeded rows: every group is enabled', async () => {
    const rig = await makeRig();
    const r = createExposureReader({ db: rig.db, clock: rig.clock });
    expect(await r.isEnabled('orders')).toBe(true);
    expect(await r.isEnabled('mcp:buy_unit')).toBe(true);
  });

  it('serves the old value for under 5 s and the new one after (injected clock)', async () => {
    const rig = await makeRig();
    const r = createExposureReader({ db: rig.db, clock: rig.clock });
    expect(await r.isEnabled('library')).toBe(true);
    await rig.db.query("UPDATE api_exposure SET enabled = false WHERE group_name = 'library'");
    try {
      rig.clock.advance(4_999);
      expect(await r.isEnabled('library')).toBe(true);
      rig.clock.advance(1);
      expect(await r.isEnabled('library')).toBe(false);
    } finally {
      await rig.db.query("UPDATE api_exposure SET enabled = true WHERE group_name = 'library'");
    }
  });

  it('a cache_ms above 5000 is held at 5000 and 0 reads every time', async () => {
    const rig = await makeRig();
    const long = createExposureReader({ db: rig.db, clock: rig.clock, cache_ms: 60_000 });
    const none = createExposureReader({ db: rig.db, clock: rig.clock, cache_ms: 0 });
    await long.isEnabled('seller');
    await none.isEnabled('seller');
    await rig.db.query("UPDATE api_exposure SET enabled = false WHERE group_name = 'seller'");
    try {
      expect(await none.isEnabled('seller')).toBe(false);
      rig.clock.advance(5_000);
      expect(await long.isEnabled('seller')).toBe(false);
    } finally {
      await rig.db.query("UPDATE api_exposure SET enabled = true WHERE group_name = 'seller'");
    }
  });

  it('a failed read answers disabled for every group, and a missing row counts as disabled', async () => {
    const rig = await makeRig();
    const broken = createExposureReader({
      db: { ...rig.db, query: async () => Promise.reject(new Error('down')) } as never,
      clock: rig.clock,
    });
    for (const g of ['catalogue', 'orders', 'mcp', 'mcp:buy_unit'] as const)
      expect(await broken.isEnabled(g), g).toBe(false);
    const empty = createExposureReader({
      db: { ...rig.db, query: async () => ({ rows: [] }) } as never,
      clock: rig.clock,
    });
    expect(await empty.isEnabled('orders')).toBe(false);
    expect(
      await createExposureReader({ db: rig.db, clock: rig.clock }).isEnabled('nope' as never),
    ).toBe(false);
  });
});

describe('the check in withRoute', () => {
  it('a disabled group answers 403 api_disabled to a verified key; other groups still work', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read', 'catalogue:read']);
    const deps = { ...rig.deps, exposure: off('orders') };
    const orders = withRoute(getOrders, Empty, ok)(deps);
    const res = await orders(rig.bearer(k.token, { url: '/api/v1/orders' }));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('api_disabled');
    const cat = withRoute(
      { ...getOrders, path: '/api/v1/catalogue/search', scopes: ['catalogue:read'] },
      Empty,
      ok,
    )(deps);
    expect((await cat(rig.bearer(k.token, { url: '/api/v1/catalogue/search' }))).status).toBe(200);
  });

  it('no key, a wrong key and a revoked-looking token still answer 401 unauthenticated, never api_disabled', async () => {
    const rig = await makeV1Rig();
    const orders = withRoute(getOrders, Empty, ok)({ ...rig.deps, exposure: off('orders') });
    const none = await orders(new Request(`${ORIGIN}/api/v1/orders`));
    expect(none.status).toBe(401);
    expect(await codeOf(none)).toBe('unauthenticated');
    const bad = await orders(rig.bearer('umk_live_notakey', { url: '/api/v1/orders' }));
    expect(bad.status).toBe(401);
    expect(await codeOf(bad)).toBe('unauthenticated');
  });

  it('runs before the operator-key rule, the scope check and the idempotency lookup', async () => {
    const rig = await makeV1Rig();
    // a key that lacks the scope: the disabled group answers first
    const weak = await rig.issue(BUYER_A, 'api_client', ['catalogue:read']);
    const orders = withRoute(getOrders, Empty, ok)({ ...rig.deps, exposure: off('orders') });
    expect(await codeOf(await orders(rig.bearer(weak.token, { url: '/api/v1/orders' })))).toBe(
      'api_disabled',
    );
    // an operator key on a non-GET: api_disabled, not mfa_required
    const opKey = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    const opPost = withRoute(
      { ...postOrders, path: '/api/v1/ops/things', scopes: ['ops:read'] },
      Body,
      ok,
    );
    const call = () =>
      rig.bearer(opKey.token, {
        method: 'POST',
        url: '/api/v1/ops/things',
        body: { n: 1 },
        headers: { 'idempotency-key': 'op-key-0001-abc' },
      });
    const closed = await opPost({ ...rig.deps, exposure: off('ops') })(call());
    expect(closed.status).toBe(403);
    expect(await codeOf(closed)).toBe('api_disabled');
    // with the group open the operator-key rule answers, so the order of the two checks is proven
    const open = await opPost({ ...rig.deps, exposure: { isEnabled: async () => true } })(call());
    expect(await codeOf(open)).toBe('mfa_required');
  });

  it('a replayed Idempotency-Key after the group is disabled gets 403 api_disabled, never the stored 200', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let enabled = true;
    const reader: ExposureReader = { isEnabled: async () => enabled };
    const post = withRoute(postOrders, Body, ok)({ ...rig.deps, exposure: reader });
    const req = () =>
      rig.bearer(k.token, {
        method: 'POST',
        url: '/api/v1/orders',
        body: { n: 1 },
        headers: { 'idempotency-key': 'replay-key-0001' },
      });
    expect((await post(req())).status).toBe(200);
    enabled = false;
    const replay = await post(req());
    expect(replay.status).toBe(403);
    expect(await codeOf(replay)).toBe('api_disabled');
    expect(replay.headers.get('idempotent-replay')).toBeNull();
  });

  it('a read failure answers 403 for an apikey route and changes nothing for a session route', async () => {
    const rig = await makeV1Rig();
    const failing = createExposureReader({
      db: { ...rig.db, query: async () => Promise.reject(new Error('down')) } as never,
      clock: rig.clock,
    });
    const deps = { ...rig.deps, exposure: failing };
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    expect(
      (await withRoute(getOrders, Empty, ok)(deps)(rig.bearer(k.token, { url: '/api/v1/orders' })))
        .status,
    ).toBe(403);
    const s = await createSession(rig.deps, {
      kind: 'buyer',
      buyer_id: BUYER_A.kind === 'buyer' ? BUYER_A.buyer_id : '',
    });
    const sessionRoute = withRoute(
      {
        ...base,
        path: '/api/library',
        method: 'GET',
        auth: 'buyer',
        rate: null,
        idempotent: false,
      },
      Empty,
      ok,
    )(deps);
    const res = await sessionRoute(
      new Request(`${ORIGIN}/api/library`, { headers: { cookie: cookiePair(s.cookie) } }),
    );
    expect(res.status).toBe(200);
  });

  it('an apikey route whose prefix is unmapped fails closed once a reader is set', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    const r = withRoute(
      { ...getOrders, path: '/api/v1/things' },
      Empty,
      ok,
    )({
      ...rig.deps,
      exposure: { isEnabled: async () => true },
    });
    expect(await codeOf(await r(rig.bearer(k.token, { url: '/api/v1/things' })))).toBe(
      'api_disabled',
    );
  });

  it('without a reader every group is enabled (F5)', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:read']);
    const r = withRoute(getOrders, Empty, ok)(rig.deps);
    expect((await r(rig.bearer(k.token, { url: '/api/v1/orders' }))).status).toBe(200);
  });
});
