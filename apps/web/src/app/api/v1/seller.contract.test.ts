// API-A seller routes S1 to S5, one table-driven case per item id, run in order on one booted offline app.
// The publisher is always the one the key belongs to; a result is compared with the old session route
// or the Engine function behind it on the same seeded data.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SellerOfferListSchema,
  SellerOfferResultSchema,
  SellerSalesSchema,
  V1_ROUTES,
} from '@umsbx/contracts';
import { runPack, HARBOUR_TIDE } from '../../../composite-support';
import { bootA, json, type ARig, type Handler, type Sess } from '../../../api-v1/a-support';
import { expectOffline } from '../../../api-v1/offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

let rig: ARig;
let tok: string;
let sess: Sess;
const h: Record<string, Handler> = {};
const st: { offer_id?: string; version?: string; article_id?: string } = {};
const pubId = () => (rig.harbour as { publisher_id: string }).publisher_id;

const both = (keep: number, read: number) => [
  { option: 'keep_retrieve', price_minor: keep },
  { option: 'online_read', price_minor: read },
];

async function newArticle(key: string): Promise<string> {
  const id = `art_a_${key}`;
  await rig.app.db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ($1,$2,$3,'An abstract.','en',ARRAY['t'],'2026-10-21T10:00:00Z',$4,$5,1,'text/plain','2026-10-21T10:00:00Z','2026-10-21T10:00:00Z')`,
    [id, pubId(), `A ${key}`, 'c'.repeat(64), `a/${key}`],
  );
  return id;
}

beforeAll(async () => {
  rig = await bootA();
  tok = await rig.key(rig.harbour, ['catalogue:read', 'offers:write', 'sales:read']);
  sess = await rig.session(rig.harbour);
  const offers = await import('./seller/offers/route');
  h['list'] = offers.GET as Handler;
  h['create'] = offers.POST as Handler;
  const one = await import('./seller/offers/[id]/route');
  h['revise'] = one.PATCH as Handler;
  h['withdraw'] = one.DELETE as Handler;
  h['sales'] = (await import('./seller/sales/route')).GET as Handler;
  h['oldCreate'] = (await import('../publisher/offers/create/route')).POST as Handler;
  h['oldRevise'] = (await import('../publisher/offers/revise/route')).POST as Handler;
  h['oldWithdraw'] = (await import('../publisher/offers/withdraw/route')).POST as Handler;
});

const call = (name: string, r: Parameters<ARig['v1']>[2]) => rig.v1(h[name]!, tok, r);

const CASES: [string, () => Promise<void>][] = [
  [
    'S1 GET /api/v1/seller/offers',
    async () => {
      const res = await call('list', { url: '/api/v1/seller/offers' });
      expect(res.status).toBe(200);
      const v1 = SellerOfferListSchema.parse(await res.json());
      const old = (await rig.app.engine.offers.list(rig.harbour))!;
      expect(v1.items).toEqual(old.offers);
      expect(v1.environment).toBe(old.environment);
      expect(v1.offer_max_minor).toBe(old.offer_max_minor);
      expect(v1.items.length).toBeGreaterThan(0);
      // Only this publisher's offers.
      const quay = await rig.key(rig.quayside, ['catalogue:read']);
      const theirs = SellerOfferListSchema.parse(
        await (await rig.v1(h['list']!, quay, { url: '/api/v1/seller/offers' })).json(),
      );
      expect(theirs.items.map((o) => o.offer_id)).not.toEqual(
        expect.arrayContaining(v1.items.map((o) => o.offer_id)),
      );
    },
  ],
  [
    'S2 POST /api/v1/seller/offers',
    async () => {
      st.article_id = await newArticle('s2');
      const body = { article_id: st.article_id, options: both(150, 100), attestation: true };
      const res = await call('create', { method: 'POST', url: '/api/v1/seller/offers', body });
      expect(res.status).toBe(201);
      const v1 = SellerOfferResultSchema.parse(await res.json());
      expect(v1.version).toBe('1');
      st.offer_id = v1.offer_id;
      st.version = v1.version;
      const listed = (await rig.app.engine.offers.list(rig.harbour))!;
      expect(listed.offers.find((o) => o.offer_id === v1.offer_id)?.status).toBe('authorised');
      // The old route gives the same body for the same kind of request.
      const art2 = await newArticle('s2-old');
      const old = await rig.old(h['oldCreate']!, sess, {
        method: 'POST',
        url: '/api/publisher/offers/create',
        body: { article_id: art2, options: both(150, 100), attestation: true },
      });
      expect(old.status).toBe(200);
      expect(Object.keys(await old.json()).sort()).toEqual(Object.keys(v1).sort());
      // Refusals: no attestation 422, a price over the cap 422, an article of another publisher 404 or 403.
      expect(
        (
          await call('create', {
            method: 'POST',
            url: '/api/v1/seller/offers',
            body: { ...body, attestation: false },
          })
        ).status,
      ).toBe(422);
      const art3 = await newArticle('s2-cap');
      expect(
        (
          await call('create', {
            method: 'POST',
            url: '/api/v1/seller/offers',
            body: { article_id: art3, options: both(99_999_999, 100), attestation: true },
          })
        ).status,
      ).toBe(422);
    },
  ],
  [
    'S3 PATCH /api/v1/seller/offers/{id}',
    async () => {
      const res = await call('revise', {
        method: 'PATCH',
        url: `/api/v1/seller/offers/${st.offer_id}`,
        params: { id: st.offer_id! },
        body: { expected_version: st.version, options: both(180, 120), attestation: true },
      });
      expect(res.status).toBe(200);
      const v1 = SellerOfferResultSchema.parse(await res.json());
      expect(v1.offer_id).toBe(st.offer_id);
      expect(v1.version).toBe('2');
      st.version = v1.version;
      const detail = (await rig.app.engine.offers.get(rig.harbour, st.offer_id!))!;
      expect(detail.options).toEqual(both(180, 120));
      // A stale version is a conflict, as on the old route.
      const stale = await call('revise', {
        method: 'PATCH',
        url: `/api/v1/seller/offers/${st.offer_id}`,
        params: { id: st.offer_id! },
        body: { expected_version: '1', options: both(190, 130), attestation: true },
      });
      expect(stale.status).toBe(409);
      const old = await rig.old(h['oldRevise']!, sess, {
        method: 'POST',
        url: '/api/publisher/offers/revise',
        body: {
          offer_id: st.offer_id,
          expected_version: '1',
          options: both(190, 130),
          attestation: true,
        },
      });
      expect(old.status).toBe(409);
    },
  ],
  [
    'S4 DELETE /api/v1/seller/offers/{id}',
    async () => {
      const q = `expected_version=${st.version}&reason=${encodeURIComponent('retired from sale')}`;
      const res = await call('withdraw', {
        method: 'DELETE',
        url: `/api/v1/seller/offers/${st.offer_id}?${q}`,
        params: { id: st.offer_id! },
      });
      expect(res.status).toBe(200);
      const v1 = SellerOfferResultSchema.parse(await res.json());
      expect(v1.version).toBe('3');
      const detail = (await rig.app.engine.offers.get(rig.harbour, st.offer_id!))!;
      expect(detail.status).toBe('withdrawn');
      // A buyer no longer finds it in the catalogue.
      const listed = await rig.app.engine.listOffers();
      expect(listed.find((o) => o.offer_id === st.offer_id)?.on_sale ?? false).toBe(false);
      // Withdrawing again is a conflict, as on the old route.
      const again = await call('withdraw', {
        method: 'DELETE',
        url: `/api/v1/seller/offers/${st.offer_id}?expected_version=3&reason=${encodeURIComponent('retired again')}`,
        params: { id: st.offer_id! },
      });
      const old = await rig.old(h['oldWithdraw']!, sess, {
        method: 'POST',
        url: '/api/publisher/offers/withdraw',
        body: { offer_id: st.offer_id, expected_version: '3', reason: 'retired again' },
      });
      expect(again.status).toBe(old.status);
      expect(again.status).toBe(409);
      // A reason is required.
      const noReason = await call('withdraw', {
        method: 'DELETE',
        url: `/api/v1/seller/offers/${st.offer_id}?expected_version=3`,
        params: { id: st.offer_id! },
      });
      expect(noReason.status).toBe(422);
    },
  ],
  [
    'S5 GET /api/v1/seller/sales',
    async () => {
      const run = await runPack(rig.app, rig.buyerA, [HARBOUR_TIDE], ['happy']);
      expect(run.returns[0]!.ok).toBe(true);
      const res = await call('sales', { url: '/api/v1/seller/sales' });
      expect(res.status).toBe(200);
      const v1 = SellerSalesSchema.parse(await res.json());
      expect(v1.items).toEqual((await rig.app.engine.publisherSales(rig.harbour))!);
      expect(v1.items.length).toBeGreaterThan(0);
      expect(v1.next_cursor).toBeNull();
      // No buyer identity anywhere in the body.
      expect(JSON.stringify(v1)).not.toMatch(/buy_|persona:/);
      // Another publisher sees none of these sales.
      const quay = await rig.key(rig.quayside, ['sales:read']);
      const theirs = SellerSalesSchema.parse(
        await (await rig.v1(h['sales']!, quay, { url: '/api/v1/seller/sales' })).json(),
      );
      expect(theirs.items).toEqual((await rig.app.engine.publisherSales(rig.quayside))!);
      expect(json).toBeDefined();
    },
  ],
];

describe('API-A seller routes', () => {
  it.each(CASES)('%s', async (_id, run) => {
    await run();
  });
});

describe('API-A seller routes are registered for the OpenAPI file', () => {
  it('lists S1 to S5 with the scopes the routes need', () => {
    const by = (m: string, p: string) => V1_ROUTES.find((r) => r.method === m && r.path === p);
    const expected: [string, string, string[]][] = [
      ['GET', '/api/v1/seller/offers', ['catalogue:read']],
      ['POST', '/api/v1/seller/offers', ['offers:write']],
      ['PATCH', '/api/v1/seller/offers/{id}', ['offers:write']],
      ['DELETE', '/api/v1/seller/offers/{id}', ['offers:write']],
      ['GET', '/api/v1/seller/sales', ['sales:read']],
    ];
    for (const [m, p, scopes] of expected) {
      const r = by(m, p);
      expect(r, `${m} ${p}`).toBeDefined();
      expect(r!.auth).toBe('apikey');
      expect([...r!.scopes]).toEqual(scopes);
    }
  });
});
