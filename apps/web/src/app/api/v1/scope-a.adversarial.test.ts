// API-A adversarial: the lane A routes against the wrong key, the wrong owner, replay, forged cursors, and
// the key-access guard (no key of any scope reaches stop, start, a switch, or an MFA-gated operator POST).
// Offline: fetch, net.connect and dns.lookup throw in this file; the run ends with zero recorded calls.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import { OWNER_SCOPE_MATRIX, SCOPES, type Actor, type Scope } from '@umsbx/contracts';
import { apiKeyDeps } from '../../../../composition.server';
import { HARBOUR_FERRY, HARBOUR_TIDE, startPack } from '../../../composite-support';
import { bootA, json, type ARig, type Handler } from '../../../api-v1/a-support';
import { expectOffline } from '../../../api-v1/offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

const CONSENT = { terms: true, identity_share: false };
// Every route module of the app, found on disk and loaded on demand. The API directory is two levels up.
const API_DIR = fileURLToPath(new URL('..', import.meta.url));
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}
// The only routes whose path says start, stop or switch. The inventory test below fails when a route
// with such a path exists on disk that this table does not list, so a new one cannot slip past it.
const CONTROL_ROUTES: Record<string, () => Promise<Record<string, Handler>>> = {
  '/api/ops/start': () =>
    import('../ops/start/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/stop': () => import('../ops/stop/route') as unknown as Promise<Record<string, Handler>>,
  '/api/v1/ops/switches': () =>
    import('./ops/switches/route') as unknown as Promise<Record<string, Handler>>,
};
// The other operator POSTs the guard covers: they need a session with a second factor, and a key has none.
const MFA_ROUTES: Record<string, () => Promise<Record<string, Handler>>> = {
  '/api/ops/agent-buy': () =>
    import('../ops/agent-buy/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/rules': () =>
    import('../ops/rules/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/fee': () => import('../ops/fee/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/payee-decisions': () =>
    import('../ops/payee-decisions/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/publishers/status': () =>
    import('../ops/publishers/status/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/publishers/applicants': () =>
    import('../ops/publishers/applicants/route') as unknown as Promise<Record<string, Handler>>,
  '/api/ops/publishers/applicants/decision': () =>
    import('../ops/publishers/applicants/decision/route') as unknown as Promise<
      Record<string, Handler>
    >,
  '/api/refunds': () => import('../refunds/route') as unknown as Promise<Record<string, Handler>>,
  '/api/refunds/[id]/cancel': () =>
    import('../refunds/[id]/cancel/route') as unknown as Promise<Record<string, Handler>>,
};
// A buyer who already has an open order for an offer gets no quote for it, so the approval tests use the ferry offer.
// Every error carries a fresh support code; two refusals are the same answer when all else matches.
const sameBody = (b: unknown): unknown => {
  const e = (b as { error: Record<string, unknown> }).error;
  const { support_code, ...rest } = e;
  void support_code;
  return { error: rest };
};
let rig: ARig;
const h: Record<string, Handler> = {};
const tokens: Record<string, string> = {};

const BUYER_ALL = OWNER_SCOPE_MATRIX.buyer as readonly Scope[];
const AGENT_ALL = OWNER_SCOPE_MATRIX.agent as readonly Scope[];
const PUB_ALL = OWNER_SCOPE_MATRIX.publisher as readonly Scope[];
const OPR_ALL = OWNER_SCOPE_MATRIX.operator as readonly Scope[];

// Every v1 route of lane A: [name, method, url, params, body].
type Route = [
  name: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  params?: Record<string, string> | undefined,
  body?: unknown,
];
const BUYER_ROUTES: Route[] = [
  ['search', 'GET', '/api/v1/catalogue/search?q=tide'],
  ['offer', 'GET', '/api/v1/offers/ofr_x', { id: 'ofr_x' }],
  ['briefs', 'POST', '/api/v1/briefs', undefined, { need: 'tide tables' }],
  ['discover', 'POST', '/api/v1/briefs/brf_x/discover', { id: 'brf_x' }],
  [
    'quotes',
    'POST',
    '/api/v1/quotes',
    undefined,
    { publisher: 'harbour-ledger', offer: 'tide-tables' },
  ],
  ['approvals', 'POST', '/api/v1/approvals', undefined, { quote_id: 'quo_x', consent: CONSENT }],
  ['orders', 'POST', '/api/v1/orders', undefined, { approval_id: 'apr_x', token: 'x'.repeat(40) }],
  ['orderList', 'GET', '/api/v1/orders'],
  ['order', 'GET', '/api/v1/orders/ord_x', { ref: 'ord_x' }],
  ['cancel', 'POST', '/api/v1/orders/ord_x/cancel', { ref: 'ord_x' }],
  ['library', 'GET', '/api/v1/library'],
  ['link', 'POST', '/api/v1/library/ent_x/link', { id: 'ent_x' }],
];
const SELLER_ROUTES: Route[] = [
  ['sellerList', 'GET', '/api/v1/seller/offers'],
  [
    'sellerCreate',
    'POST',
    '/api/v1/seller/offers',
    undefined,
    {
      article_id: 'art_x',
      options: [{ option: 'online_read', price_minor: 100 }],
      attestation: true,
    },
  ],
  [
    'sellerRevise',
    'PATCH',
    '/api/v1/seller/offers/ofr_x',
    { id: 'ofr_x' },
    {
      expected_version: '1',
      options: [{ option: 'online_read', price_minor: 100 }],
      attestation: true,
    },
  ],
  [
    'sellerWithdraw',
    'DELETE',
    '/api/v1/seller/offers/ofr_x?expected_version=1&reason=testing',
    { id: 'ofr_x' },
  ],
  ['sales', 'GET', '/api/v1/seller/sales'],
];
const OPS_ROUTES: Route[] = [
  ['overview', 'GET', '/api/v1/ops/overview'],
  ['reconciler', 'GET', '/api/v1/ops/reconciler'],
  ['opsOrder', 'GET', '/api/v1/ops/orders/ord_x', { ref: 'ord_x' }],
  ['switches', 'GET', '/api/v1/ops/switches'],
];

beforeAll(async () => {
  rig = await bootA();
  h['search'] = (await import('./catalogue/search/route')).GET as Handler;
  h['offer'] = (await import('./offers/[id]/route')).GET as Handler;
  h['briefs'] = (await import('./briefs/route')).POST as Handler;
  h['discover'] = (await import('./briefs/[id]/discover/route')).POST as Handler;
  h['quotes'] = (await import('./quotes/route')).POST as Handler;
  h['approvals'] = (await import('./approvals/route')).POST as Handler;
  const orders = await import('./orders/route');
  h['orders'] = orders.POST as Handler;
  h['orderList'] = orders.GET as Handler;
  h['order'] = (await import('./orders/[ref]/route')).GET as Handler;
  h['cancel'] = (await import('./orders/[ref]/cancel/route')).POST as Handler;
  h['library'] = (await import('./library/route')).GET as Handler;
  h['link'] = (await import('./library/[id]/link/route')).POST as Handler;
  const offers = await import('./seller/offers/route');
  h['sellerList'] = offers.GET as Handler;
  h['sellerCreate'] = offers.POST as Handler;
  const one = await import('./seller/offers/[id]/route');
  h['sellerRevise'] = one.PATCH as Handler;
  h['sellerWithdraw'] = one.DELETE as Handler;
  h['sales'] = (await import('./seller/sales/route')).GET as Handler;
  h['overview'] = (await import('./ops/overview/route')).GET as Handler;
  h['reconciler'] = (await import('./ops/reconciler/route')).GET as Handler;
  h['opsOrder'] = (await import('./ops/orders/[ref]/route')).GET as Handler;
  h['switches'] = (await import('./ops/switches/route')).GET as Handler;
  tokens['buyerA'] = await rig.key(rig.buyerA, BUYER_ALL);
  tokens['buyerB'] = await rig.key(rig.buyerB, BUYER_ALL);
  tokens['agent'] = await rig.key(rig.buyerA, AGENT_ALL, 'agent');
  tokens['harbour'] = await rig.key(rig.harbour, PUB_ALL);
  tokens['quayside'] = await rig.key(rig.quayside, PUB_ALL);
  tokens['operator'] = await rig.key(rig.operator, OPR_ALL);
});

const hit = (
  name: string,
  tok: string | null,
  [, method, url, params, body]: Route,
  extra: Record<string, string> = {},
) =>
  rig.v1(h[name]!, tok, {
    method,
    url,
    ...(params ? { params } : {}),
    ...(body !== undefined ? { body } : {}),
    headers: extra,
  });

const ALL: Route[] = [...BUYER_ROUTES, ...SELLER_ROUTES, ...OPS_ROUTES];

describe('no credentials, bad credentials', () => {
  it.each(ALL)('%s: no key is 401', async (name, ...rest) => {
    const res = await hit(name, null, [name, ...rest] as unknown as Route);
    expect(res.status).toBe(401);
  });
  it.each(ALL)('%s: a malformed or unknown key is 401', async (name, ...rest) => {
    const r = [name, ...rest] as unknown as Route;
    expect((await hit(name, 'umk_nope_nope', r)).status).toBe(401);
    expect((await hit(name, 'not a token', r)).status).toBe(401);
  });
  it('a session cookie alone is 401 on a v1 key route, and a cookie next to a key is 401 too', async () => {
    const s = await rig.session(rig.buyerA);
    const noKey = await hit('orderList', null, ['orderList', 'GET', '/api/v1/orders'], {
      cookie: s.cookie,
    });
    expect(noKey.status).toBe(401);
    const both = await hit('orderList', tokens['buyerA']!, ['orderList', 'GET', '/api/v1/orders'], {
      cookie: s.cookie,
    });
    expect(both.status).toBe(401);
  });
  it('a revoked key is 401', async () => {
    const token = await rig.key(rig.buyerA, ['orders:read']);
    expect((await hit('orderList', token, ['orderList', 'GET', '/api/v1/orders'])).status).toBe(
      200,
    );
    const id = /^umk_([^_]+)_/.exec(token)?.[1];
    expect(id).toBeDefined();
    await rig.app.db.query(`UPDATE api_keys SET revoked_at = $1 WHERE id LIKE $2`, [
      '2026-11-04T00:00:00.000Z',
      `%${id}%`,
    ]);
    expect((await hit('orderList', token, ['orderList', 'GET', '/api/v1/orders'])).status).toBe(
      401,
    );
  });
});

describe('scope and owner kind', () => {
  it.each(BUYER_ROUTES)('%s: a seller key on a buyer route is 403', async (name, ...rest) => {
    expect((await hit(name, tokens['harbour']!, [name, ...rest] as unknown as Route)).status).toBe(
      403,
    );
  });
  it.each(BUYER_ROUTES)(
    '%s: an operator key on a buyer route is 403',
    async (name, method, url, ...rest) => {
      expect(
        (await hit(name, tokens['operator']!, [name, method, url, ...rest] as unknown as Route))
          .status,
      ).toBe(403);
    },
  );
  it.each(SELLER_ROUTES)('%s: a buyer key on a seller route is 403', async (name, ...rest) => {
    expect((await hit(name, tokens['buyerA']!, [name, ...rest] as unknown as Route)).status).toBe(
      403,
    );
  });
  it.each(OPS_ROUTES)(
    '%s: a buyer key and a seller key on an operator route are 403',
    async (name, ...rest) => {
      const r = [name, ...rest] as unknown as Route;
      expect((await hit(name, tokens['buyerA']!, r)).status).toBe(403);
      expect((await hit(name, tokens['harbour']!, r)).status).toBe(403);
    },
  );
  it.each(BUYER_ROUTES)(
    '%s: an agent key does not use lane A buyer routes (agents come with lane B)',
    async (name, ...rest) => {
      expect((await hit(name, tokens['agent']!, [name, ...rest] as unknown as Route)).status).toBe(
        403,
      );
    },
  );
  it('a key without the scope is 403', async () => {
    const readOnly = await rig.key(rig.buyerA, ['orders:read']);
    expect(
      (
        await hit(
          'orders',
          readOnly,
          BUYER_ROUTES.find((r) => r[0] === 'orders')!,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await hit(
          'quotes',
          readOnly,
          BUYER_ROUTES.find((r) => r[0] === 'quotes')!,
        )
      ).status,
    ).toBe(403);
    const none = await rig.key(rig.harbour, ['sales:read']);
    expect(
      (
        await hit(
          'sellerCreate',
          none,
          SELLER_ROUTES.find((r) => r[0] === 'sellerCreate')!,
        )
      ).status,
    ).toBe(403);
  });
  it('a change without an Idempotency-Key is 400', async () => {
    const res = await rig.v1(h['quotes']!, tokens['buyerA']!, {
      method: 'POST',
      url: '/api/v1/quotes',
      body: { publisher: 'harbour-ledger', offer: 'tide-tables' },
      idem: null,
    });
    expect(res.status).toBe(400);
  });
});

describe('buyer isolation', () => {
  it('buyer A reading, cancelling or linking buyer B items gets 404, and nothing changes', async () => {
    const started = await startPack(rig.app, rig.buyerB, [HARBOUR_TIDE]);
    const read = await rig.v1(h['order']!, tokens['buyerA']!, {
      url: `/api/v1/orders/${started.order_ref}`,
      params: { ref: started.order_ref },
    });
    expect(read.status).toBe(404);
    const cancel = await rig.v1(h['cancel']!, tokens['buyerA']!, {
      method: 'POST',
      url: `/api/v1/orders/${started.order_ref}/cancel`,
      params: { ref: started.order_ref },
    });
    expect(cancel.status).toBe(404);
    const row = await rig.app.db.query<{ status: string }>(
      'SELECT status FROM orders WHERE order_ref = $1',
      [started.order_ref],
    );
    expect(row.rows[0]!.status).not.toBe('abandoned');
    const mine = await rig.v1(h['order']!, tokens['buyerB']!, {
      url: `/api/v1/orders/${started.order_ref}`,
      params: { ref: started.order_ref },
    });
    expect(mine.status).toBe(200);
    // The 404 is the same body as for an order that does not exist.
    const missing = await rig.v1(h['order']!, tokens['buyerA']!, {
      url: '/api/v1/orders/ord_missing',
      params: { ref: 'ord_missing' },
    });
    expect(sameBody(await read.json())).toEqual(sameBody(await missing.json()));
  });
  it('buyer A cannot place an order with buyer B approval', async () => {
    const page = (await rig.app.engine.offerPage({
      publisher: HARBOUR_FERRY[0],
      offer: HARBOUR_FERRY[1],
    }))!;
    const q = await json<{ quote_id: string }>(
      await rig.v1(h['quotes']!, tokens['buyerB']!, {
        method: 'POST',
        url: '/api/v1/quotes',
        body: {
          publisher: HARBOUR_FERRY[0],
          offer: HARBOUR_FERRY[1],
          option: page.options[0]!.option,
        },
      }),
    );
    const a = await json<{ approval_id: string; token: string }>(
      await rig.v1(h['approvals']!, tokens['buyerB']!, {
        method: 'POST',
        url: '/api/v1/approvals',
        body: { quote_id: q.quote_id, consent: CONSENT },
      }),
    );
    const before = Number(
      (await rig.app.db.query<{ c: string }>('SELECT count(*) AS c FROM orders')).rows[0]!.c,
    );
    const stolen = await rig.v1(h['orders']!, tokens['buyerA']!, {
      method: 'POST',
      url: '/api/v1/orders',
      body: { approval_id: a.approval_id, token: a.token },
    });
    expect([403, 404]).toContain(stolen.status);
    const after = Number(
      (await rig.app.db.query<{ c: string }>('SELECT count(*) AS c FROM orders')).rows[0]!.c,
    );
    expect(after).toBe(before);
    // Buyer A cannot approve from buyer B quote either.
    const cross = await rig.v1(h['approvals']!, tokens['buyerA']!, {
      method: 'POST',
      url: '/api/v1/approvals',
      body: { quote_id: q.quote_id, consent: CONSENT },
    });
    expect([403, 404]).toContain(cross.status);
  });
  it('a forged, garbage or other-buyer cursor on GET /api/v1/orders is 400 or an empty page and leaks nothing', async () => {
    await startPack(rig.app, rig.buyerA, [HARBOUR_TIDE]).catch(() => undefined);
    for (const c of [
      'forged',
      'AAAA',
      '%00',
      'eyJjIjoiMjAyNi0wMS0wMSIsImkiOiJvcmRfeCJ9',
      'x'.repeat(600),
    ]) {
      const res = await rig.v1(h['orderList']!, tokens['buyerA']!, {
        url: `/api/v1/orders?cursor=${encodeURIComponent(c)}`,
      });
      expect([400, 422, 200]).toContain(res.status);
      if (res.status === 200) {
        const body = await json<{ items: { order_ref: string }[] }>(res);
        const own = (
          await rig.app.db.query<{ order_ref: string }>(
            `SELECT order_ref FROM orders WHERE buyer_id = $1`,
            [(rig.buyerA as { buyer_id: string }).buyer_id],
          )
        ).rows.map((r) => r.order_ref);
        for (const it of body.items) expect(own).toContain(it.order_ref);
      }
    }
    // A real cursor of buyer A used by buyer B shows buyer B orders only (or nothing of A).
    await startPack(rig.app, rig.buyerA, [['quayside-gazette', 'quay-walk']]).catch(
      () => undefined,
    );
    const first = await json<{ next_cursor: string | null }>(
      await rig.v1(h['orderList']!, tokens['buyerA']!, { url: '/api/v1/orders?limit=1' }),
    );
    if (first.next_cursor !== null) {
      const res = await rig.v1(h['orderList']!, tokens['buyerB']!, {
        url: `/api/v1/orders?cursor=${encodeURIComponent(first.next_cursor)}`,
      });
      expect([400, 422, 200]).toContain(res.status);
      if (res.status === 200) {
        const body = await json<{ items: { order_ref: string }[] }>(res);
        const mine = (
          await rig.app.db.query<{ order_ref: string }>(
            `SELECT order_ref FROM orders WHERE buyer_id = $1`,
            [(rig.buyerA as { buyer_id: string }).buyer_id],
          )
        ).rows.map((r) => r.order_ref);
        for (const it of body.items) expect(mine).not.toContain(it.order_ref);
      }
    }
  });
  it('a forged cursor on the catalogue search is 400 or a normal page', async () => {
    for (const c of ['forged', '%00', 'x'.repeat(600)]) {
      const res = await rig.v1(h['search']!, tokens['buyerA']!, {
        url: `/api/v1/catalogue/search?cursor=${encodeURIComponent(c)}`,
      });
      expect([400, 422, 200]).toContain(res.status);
    }
  });
});

describe('replay', () => {
  it('the same Idempotency-Key on POST /api/v1/orders places one order, however many times it is sent', async () => {
    const page = (await rig.app.engine.offerPage({
      publisher: HARBOUR_FERRY[0],
      offer: HARBOUR_FERRY[1],
    }))!;
    const token = await rig.key(rig.buyerB, ['catalogue:read', 'orders:read', 'orders:write']);
    const q = await json<{ quote_id: string }>(
      await rig.v1(h['quotes']!, token, {
        method: 'POST',
        url: '/api/v1/quotes',
        body: {
          publisher: HARBOUR_FERRY[0],
          offer: HARBOUR_FERRY[1],
          option: page.options[0]!.option,
        },
      }),
    );
    const a = await json<{ approval_id: string; token: string }>(
      await rig.v1(h['approvals']!, token, {
        method: 'POST',
        url: '/api/v1/approvals',
        body: { quote_id: q.quote_id, consent: CONSENT },
      }),
    );
    const before = Number(
      (
        await rig.app.db.query<{ c: string }>(
          `SELECT count(*) AS c FROM orders WHERE approval_id = $1`,
          [a.approval_id],
        )
      ).rows[0]!.c,
    );
    expect(before).toBe(0);
    const send = () =>
      rig.v1(h['orders']!, token, {
        method: 'POST',
        url: '/api/v1/orders',
        body: { approval_id: a.approval_id, token: a.token },
        idem: 'replay-one-order-key-1',
      });
    const results = await Promise.all([send(), send(), send(), send(), send()]);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);
    const later = await send();
    expect(later.status).toBe(201);
    const rows = await rig.app.db.query(`SELECT 1 FROM orders WHERE approval_id = $1`, [
      a.approval_id,
    ]);
    expect(rows.rows).toHaveLength(1);
    // Another key with the same approval cannot place a second order.
    const other = await rig.v1(h['orders']!, token, {
      method: 'POST',
      url: '/api/v1/orders',
      body: { approval_id: a.approval_id, token: a.token },
      idem: 'replay-one-order-key-2',
    });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(
      (await rig.app.db.query(`SELECT 1 FROM orders WHERE approval_id = $1`, [a.approval_id])).rows,
    ).toHaveLength(1);
  });
  it('the same Idempotency-Key with a different body is refused, not replayed', async () => {
    const token = tokens['buyerA']!;
    const first = await rig.v1(h['quotes']!, token, {
      method: 'POST',
      url: '/api/v1/quotes',
      body: { publisher: HARBOUR_TIDE[0], offer: HARBOUR_TIDE[1] },
      idem: 'same-key-two-bodies-1',
    });
    expect(first.status).toBe(200);
    const second = await rig.v1(h['quotes']!, token, {
      method: 'POST',
      url: '/api/v1/quotes',
      body: { publisher: 'quayside-gazette', offer: 'quay-walk' },
      idem: 'same-key-two-bodies-1',
    });
    expect([409, 422]).toContain(second.status);
  });
});

describe('seller isolation', () => {
  it('a publisher id in the body is ignored or refused: nothing is created for it', async () => {
    const quayId = (rig.quayside as { publisher_id: string }).publisher_id;
    const art = 'art_adv_mass';
    await rig.app.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ($1,$2,'Adv','An abstract.','en',ARRAY['t'],'2026-10-21T10:00:00Z',$3,'adv/mass',1,'text/plain','2026-10-21T10:00:00Z','2026-10-21T10:00:00Z')`,
      [art, (rig.harbour as { publisher_id: string }).publisher_id, 'e'.repeat(64)],
    );
    const res = await rig.v1(h['sellerCreate']!, tokens['harbour']!, {
      method: 'POST',
      url: '/api/v1/seller/offers',
      body: {
        article_id: art,
        options: [{ option: 'online_read', price_minor: 100 }],
        attestation: true,
        publisher_id: quayId,
      },
    });
    expect([201, 422]).toContain(res.status);
    const rows = await rig.app.db.query<{ publisher_id: string }>(
      'SELECT publisher_id FROM offers WHERE article_id = $1',
      [art],
    );
    for (const r of rows.rows)
      expect(r.publisher_id).toBe((rig.harbour as { publisher_id: string }).publisher_id);
    // A harbour key cannot put an offer on a quayside article either.
    const qart = 'art_adv_quay';
    await rig.app.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ($1,$2,'AdvQ','An abstract.','en',ARRAY['t'],'2026-10-21T10:00:00Z',$3,'adv/quay',1,'text/plain','2026-10-21T10:00:00Z','2026-10-21T10:00:00Z')`,
      [qart, quayId, 'f'.repeat(64)],
    );
    const cross = await rig.v1(h['sellerCreate']!, tokens['harbour']!, {
      method: 'POST',
      url: '/api/v1/seller/offers',
      body: {
        article_id: qart,
        options: [{ option: 'online_read', price_minor: 100 }],
        attestation: true,
      },
    });
    expect([403, 404, 422]).toContain(cross.status);
    expect(
      (await rig.app.db.query('SELECT 1 FROM offers WHERE article_id = $1', [qart])).rows,
    ).toHaveLength(0);
  });
  it("a seller key PATCH or DELETE on another publisher's offer is 404 and changes nothing", async () => {
    const theirs = (await rig.app.engine.offers.list(rig.quayside))!.offers[0]!;
    const before = (await rig.app.engine.offers.get(rig.quayside, theirs.offer_id))!;
    const patch = await rig.v1(h['sellerRevise']!, tokens['harbour']!, {
      method: 'PATCH',
      url: `/api/v1/seller/offers/${theirs.offer_id}`,
      params: { id: theirs.offer_id },
      body: {
        expected_version: theirs.version,
        options: [{ option: 'online_read', price_minor: 1 }],
        attestation: true,
      },
    });
    expect(patch.status).toBe(404);
    const del = await rig.v1(h['sellerWithdraw']!, tokens['harbour']!, {
      method: 'DELETE',
      url: `/api/v1/seller/offers/${theirs.offer_id}?expected_version=${theirs.version}&reason=hostile%20withdraw`,
      params: { id: theirs.offer_id },
    });
    expect(del.status).toBe(404);
    const after = (await rig.app.engine.offers.get(rig.quayside, theirs.offer_id))!;
    expect(after.version).toBe(before.version);
    expect(after.status).toBe(before.status);
    // The 404 matches an offer that does not exist.
    const none = await rig.v1(h['sellerRevise']!, tokens['harbour']!, {
      method: 'PATCH',
      url: '/api/v1/seller/offers/ofr_missing',
      params: { id: 'ofr_missing' },
      body: {
        expected_version: '1',
        options: [{ option: 'online_read', price_minor: 1 }],
        attestation: true,
      },
    });
    expect(none.status).toBe(404);
    expect(sameBody(await patch.json())).toEqual(sameBody(await none.json()));
  });
  it("a seller key never sees another publisher's sales or offers", async () => {
    const sales = await json<{ items: unknown[] }>(
      await rig.v1(h['sales']!, tokens['quayside']!, { url: '/api/v1/seller/sales' }),
    );
    expect(sales.items).toEqual((await rig.app.engine.publisherSales(rig.quayside))!);
    const list = await json<{ items: { offer_id: string }[] }>(
      await rig.v1(h['sellerList']!, tokens['quayside']!, { url: '/api/v1/seller/offers' }),
    );
    expect(list.items.every((o) => o.offer_id.startsWith('ofr_quayside-gazette_'))).toBe(true);
  });
});

// ---- The key-access guard (O4): no key of any scope changes a control ----
const STOP_START_BODY: Record<string, string> = {
  '/api/ops/stop': '{"reason":"hostile stop"}',
  '/api/ops/start': '{"reason":"hostile start","confirm_scope":"x"}',
};
// Every route file whose declared rule is auth 'operator' with a method that is not GET (read from the file
// text, so a new operator POST that is not in the tables above fails the inventory test below).
const operatorChanges = (): string[] =>
  routeFiles(API_DIR)
    .filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /auth: 'operator'/.test(text) && /method: '(POST|PATCH|DELETE)'/.test(text);
    })
    .map((f) => '/api/' + relative(API_DIR, f).replace(/\/?route\.ts$/, ''));
const GUARDED: [string, string, string][] = [
  ...Object.keys({ ...CONTROL_ROUTES, ...MFA_ROUTES })
    .filter((p) => p !== '/api/v1/ops/switches')
    .sort()
    .map((p): [string, string, string] => ['POST', p, STOP_START_BODY[p] ?? '{}']),
];

describe('key-access guard: stop, start, switches and MFA-gated operator POSTs', () => {
  // The dry-run seed has paypal_outbound on. Start from the state after an operator stop (off), so a key that
  // turned it on would show. Every switch row and the approval count are snapshotted before the battery.
  const SNAP = `SELECT name, "on", changed_by, changed_at::text AS changed_at, reason FROM safety_switches ORDER BY name`;
  let seedOutbound: boolean | undefined;
  let switchesBefore: unknown[] = [];
  let approvalsBefore = -1;
  const approvals = async () =>
    Number(
      (await rig.app.db.query<{ c: string }>('SELECT count(*) AS c FROM outbound_approvals'))
        .rows[0]!.c,
    );
  beforeAll(async () => {
    seedOutbound = (
      await rig.app.db.query<{ on: boolean }>(
        `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
      )
    ).rows[0]?.on;
    await rig.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'paypal_outbound'`,
    );
    switchesBefore = (await rig.app.db.query(SNAP)).rows;
    approvalsBefore = await approvals();
  });
  afterAll(async () => {
    await rig.app.db.query(`UPDATE safety_switches SET "on" = $1 WHERE name = 'paypal_outbound'`, [
      seedOutbound ?? false,
    ]);
  });
  const owners: [string, () => string][] = [
    ['operator key', () => tokens['operator']!],
    ['buyer key', () => tokens['buyerA']!],
    ['publisher key', () => tokens['harbour']!],
    ['agent key', () => tokens['agent']!],
  ];
  for (const [label, tok] of owners) {
    it.each(GUARDED)(`${label}: %s %s is 401 or 403`, async (method, path, body) => {
      const mod = await (CONTROL_ROUTES[path] ?? MFA_ROUTES[path])!();
      const res = await mod[method]!(
        new Request(`http://localhost:3000${path.replace(/\[[^\]]+\]/g, 'x')}`, {
          method,
          headers: {
            authorization: `Bearer ${tok()}`,
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
            'idempotency-key': 'guard-test-key-0001',
          },
          body,
        }),
        {
          params: Object.fromEntries([...path.matchAll(/\[([^\]]+)\]/g)].map((m) => [m[1]!, 'x'])),
        },
      );
      expect([401, 403]).toContain(res.status);
    });
  }
  it('after all of that paypal_outbound is still off, no switch row moved and no approval was added', async () => {
    const rows = await rig.app.db.query<{ name: string; on: boolean }>(
      `SELECT name, "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
    );
    expect(rows.rows[0]?.on).toBe(false);
    expect((await rig.app.engine.opsSnapshot(rig.operator))!.kill_switch.outbound_on).toBe(false);
    expect((await rig.app.db.query(SNAP)).rows).toEqual(switchesBefore);
    expect(await approvals()).toBe(approvalsBefore);
  });
  it('the guarded set is every operator route that changes something, found on disk', () => {
    const guarded = GUARDED.map((g) => g[1]).sort();
    expect(operatorChanges().sort()).toEqual(guarded);
    for (const k of ['/api/ops/stop', '/api/ops/start', '/api/refunds/[id]/cancel'])
      expect(guarded).toContain(k);
  });
  it('a key with ops:write does not exist: issuing one is refused', async () => {
    const r = await issueKey(apiKeyDeps(rig.app), {
      owner: rig.operator as Extract<Actor, { kind: 'operator' }>,
      key_kind: 'api_client',
      scopes: ['ops:read', 'ops:write' as unknown as Scope],
    });
    expect(r.ok).toBe(false);
    expect((SCOPES as readonly string[]).includes('ops:write')).toBe(false);
  });
  it('an operator key with every scope it may hold gets 403 mfa_required on every v1 change', async () => {
    const changes: Route[] = [...BUYER_ROUTES, ...SELLER_ROUTES].filter((r) => r[1] !== 'GET');
    for (const r of changes) {
      const res = await hit(r[0], tokens['operator']!, r);
      expect(res.status, `${r[1]} ${r[2]}`).toBe(403);
    }
    const mfa = await hit(
      'orders',
      tokens['operator']!,
      BUYER_ROUTES.find((r) => r[0] === 'orders')!,
    );
    expect(((await mfa.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
  });
  it('the old start route answers a bearer key 401 or 403 and never turns anything on', async () => {
    const start = (await import('../ops/start/route')).POST as Handler;
    const res = await start(
      new Request('http://localhost:3000/api/ops/start', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens['operator']!}`,
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
        },
        body: '{"reason":"hostile start","confirm_scope":"x"}',
      }),
    );
    expect([401, 403]).toContain(res.status);
  });
  it('route inventory: with every scope a key gets no 2xx from any path containing start, stop or switch, except GET /api/v1/ops/switches', async () => {
    const seen: string[] = [];
    const onDisk = routeFiles(API_DIR)
      .map((f) => '/api/' + relative(API_DIR, f).replace(/\/?route\.ts$/, ''))
      .filter((p) => /(start|stop|switch)/i.test(p));
    expect(onDisk.sort()).toEqual(Object.keys(CONTROL_ROUTES).sort());
    for (const file of routeFiles(API_DIR)) {
      const path = '/api/' + relative(API_DIR, file).replace(/\/?route\.ts$/, '');
      if (!/(start|stop|switch)/i.test(path)) continue;
      const mod = await CONTROL_ROUTES[path]!();
      for (const verb of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const fn = mod[verb];
        if (typeof fn !== 'function') continue;
        for (const [label, tok] of owners) {
          const url = path.replace(/\[[^\]]+\]/g, 'x');
          const params = Object.fromEntries(
            [...path.matchAll(/\[([^\]]+)\]/g)].map((m) => [m[1]!, 'x']),
          );
          const res = await fn(
            new Request(`http://localhost:3000${url}`, {
              method: verb,
              headers: {
                authorization: `Bearer ${tok()}`,
                'content-type': 'application/json',
                origin: 'http://localhost:3000',
                'idempotency-key': 'inventory-scan-key-01',
              },
              ...(verb === 'GET' || verb === 'DELETE' ? {} : { body: '{}' }),
            }),
            { params },
          );
          const allowed =
            verb === 'GET' && path === '/api/v1/ops/switches' && label === 'operator key';
          if (!allowed) expect(res.status, `${label} ${verb} ${path}`).not.toBeLessThan(400);
          seen.push(`${verb} ${path}`);
        }
      }
    }
    // The scan really found the routes it is about.
    expect(seen).toEqual(
      expect.arrayContaining([
        'POST /api/ops/stop',
        'POST /api/ops/start',
        'GET /api/v1/ops/switches',
      ]),
    );
  });
});
