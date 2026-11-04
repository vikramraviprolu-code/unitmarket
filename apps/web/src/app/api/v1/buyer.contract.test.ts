// API-A buyer routes B1 to B12, one table-driven case per item id, run in order on one booted offline app.
// Each case checks the status, parses the body with its v1 schema, and compares the result with what the
// matching old session route (or the Engine function behind it) gives on the same seeded data.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ApprovalIssuedSchema,
  BriefSchema,
  CatalogueSearchResponseSchema,
  LibraryListSchema,
  LinkIssuedSchema,
  OfferSummarySchema,
  OrderCancelledSchema,
  OrderListSchema,
  OrderPlacedSchema,
  OrderViewSchema,
  V1_ROUTES,
} from '@umsbx/contracts';
import { runPack, HARBOUR_TIDE, HARBOUR_FERRY, QUAY_WALK } from '../../../composite-support';
import { bootA, json, shape, type ARig, type Handler, type Sess } from '../../../api-v1/a-support';
import { expectOffline } from '../../../api-v1/offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

const NEED = 'tide tables, under $1, read online';
const CONSENT = { terms: true, identity_share: false };

let rig: ARig;
let tok: string; // buyer A, the full buyer scope set
let sessA: Sess;
const h: Record<string, Handler> = {};
// State carried from one case to the next (the cases run in order).
const st: {
  brief_id?: string;
  offer_id?: string;
  quote_id?: string;
  order_ref?: string;
  order_ref_2?: string;
  entitlement_id?: string;
} = {};

const SCOPES = ['catalogue:read', 'orders:read', 'orders:write', 'library:read'] as const;

beforeAll(async () => {
  rig = await bootA();
  tok = await rig.key(rig.buyerA, SCOPES);
  sessA = await rig.session(rig.buyerA);
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
  h['oldBriefs'] = (await import('../briefs/route')).POST as Handler;
  h['oldDiscover'] = (await import('../discover/route')).POST as Handler;
  h['oldQuotes'] = (await import('../quotes/route')).POST as Handler;
  h['oldApprovals'] = (await import('../approvals/route')).POST as Handler;
  h['oldOrder'] = (await import('../orders/[ref]/route')).GET as Handler;
  h['oldCancel'] = (await import('../orders/[ref]/cancel/route')).POST as Handler;
  h['oldLibrary'] = (await import('../library/route')).GET as Handler;
  h['oldLink'] = (await import('../library/[id]/link/route')).POST as Handler;
});

const get = (name: string, url: string, params?: Record<string, string>) =>
  rig.v1(h[name]!, tok, { url, ...(params ? { params } : {}) });
const post = (name: string, url: string, body?: unknown, params?: Record<string, string>) =>
  rig.v1(h[name]!, tok, {
    method: 'POST',
    url,
    ...(body !== undefined ? { body } : {}),
    ...(params ? { params } : {}),
  });

/** A quote, an approval and an order through the v1 routes, for the offer. */
async function placeViaV1(publisher: string, offer: string): Promise<string> {
  const page = (await rig.app.engine.offerPage({ publisher, offer }))!;
  const q = await json<{ quote_id: string }>(
    await post('quotes', '/api/v1/quotes', { publisher, offer, option: page.options[0]!.option }),
  );
  const a = await json<{ approval_id: string; token: string }>(
    await post('approvals', '/api/v1/approvals', { quote_id: q.quote_id, consent: CONSENT }),
  );
  const o = await json<{ order_id: string; order_ref: string }>(
    await post('orders', '/api/v1/orders', { approval_id: a.approval_id, token: a.token }),
  );
  // An order can be cancelled once its checkout has begun (the dry-run checkout is the app's pretend PayPal,
  // not a v1 route); a cancel before that is a 409 on the old route too.
  await rig.app.engine.payments.beginCheckout({ order_id: o.order_id, actor: rig.buyerA });
  return o.order_ref;
}

const CASES: [string, () => Promise<void>][] = [
  [
    'B1 GET /api/v1/catalogue/search',
    async () => {
      const all = await rig.app.engine.listOffers();
      const res = await get('search', '/api/v1/catalogue/search?q=tide');
      expect(res.status).toBe(200);
      const body = CatalogueSearchResponseSchema.parse(await res.json());
      expect(body.items.length).toBeGreaterThan(0);
      for (const it of body.items) {
        const old = all.find((o) => o.offer_id === it.offer_id)!;
        expect(old).toBeDefined();
        expect(it).toMatchObject({
          offer_id: old.offer_id,
          title: old.title,
          abstract: old.abstract,
          publisher: old.publisher,
          publisher_slug: old.publisher_slug,
          offer_code: old.offer_code,
          currency: old.currency,
          options: old.options,
        });
        // A seller secret never leaves: the renegotiation floor is not part of the buyer view.
        expect(Object.keys(it)).not.toContain('floor_minor');
      }
      // No query: every listed offer, cheapest first.
      const every = CatalogueSearchResponseSchema.parse(
        await (await get('search', '/api/v1/catalogue/search')).json(),
      );
      expect(every.items.map((i) => i.offer_id).sort()).toEqual(
        all
          .filter((o) => o.on_sale)
          .map((o) => o.offer_id)
          .sort(),
      );
      const prices = every.items.map((i) => i.min_price_minor);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      // Filters.
      const one = CatalogueSearchResponseSchema.parse(
        await (await get('search', '/api/v1/catalogue/search?publisher=quayside-gazette')).json(),
      );
      expect(one.items.length).toBeGreaterThan(0);
      expect(one.items.every((i) => i.publisher_slug === 'quayside-gazette')).toBe(true);
      const cheap = CatalogueSearchResponseSchema.parse(
        await (await get('search', '/api/v1/catalogue/search?max_price=1')).json(),
      );
      expect(cheap.items).toEqual([]);
      // Cursor: pages of one cover the set once.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 50; n++) {
        const page: { items: { offer_id: string }[]; next_cursor: string | null } =
          CatalogueSearchResponseSchema.parse(
            await (
              await get(
                'search',
                `/api/v1/catalogue/search?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
              )
            ).json(),
          );
        seen.push(...page.items.map((i) => i.offer_id));
        cursor = page.next_cursor;
        if (cursor === null) break;
      }
      expect(seen.sort()).toEqual(every.items.map((i) => i.offer_id).sort());
      expect(new Set(seen).size).toBe(seen.length);
      expect((await get('search', '/api/v1/catalogue/search?max_price=abc')).status).toBe(422);
    },
  ],
  [
    'B2 GET /api/v1/offers/{id}',
    async () => {
      const page = (await rig.app.engine.offerPage({
        publisher: HARBOUR_TIDE[0],
        offer: HARBOUR_TIDE[1],
      }))!;
      st.offer_id = page.offer_id;
      const res = await get('offer', `/api/v1/offers/${page.offer_id}`, { id: page.offer_id });
      expect(res.status).toBe(200);
      const body = OfferSummarySchema.parse(await res.json());
      expect(body).toMatchObject({
        offer_id: page.offer_id,
        title: page.title,
        abstract: page.abstract,
        publisher: page.publisher,
        currency: page.currency,
        options: page.options,
        language: page.language,
        bytes: page.bytes,
      });
      expect(body.rights).toEqual(page.rights);
      const missing = await get('offer', '/api/v1/offers/ofr_nothing', { id: 'ofr_nothing' });
      expect(missing.status).toBe(404);
    },
  ],
  [
    'B3 POST /api/v1/briefs',
    async () => {
      const res = await post('briefs', '/api/v1/briefs', { need: NEED });
      expect(res.status).toBe(200);
      const v1 = BriefSchema.parse(await res.json());
      expect(v1.buyer_id).toBe((rig.buyerA as { buyer_id: string }).buyer_id);
      st.brief_id = v1.brief_id;
      const old = await rig.old(h['oldBriefs']!, sessA, {
        method: 'POST',
        url: '/api/briefs',
        body: { need: NEED },
      });
      expect(old.status).toBe(200);
      const o = BriefSchema.parse(await old.json());
      const strip = ({ brief_id, created_at, ...rest }: typeof v1) => (
        void brief_id,
        void created_at,
        rest
      );
      expect(strip(v1)).toEqual(strip(o));
      // The same refusals as the old route: too long is 422, the ai switch off is 503 ai_off.
      expect((await post('briefs', '/api/v1/briefs', { need: 'x'.repeat(2001) })).status).toBe(422);
      await rig.app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'ai_enabled'`);
      try {
        const off = await post('briefs', '/api/v1/briefs', { need: NEED });
        const offOld = await rig.old(h['oldBriefs']!, sessA, {
          method: 'POST',
          url: '/api/briefs',
          body: { need: NEED },
        });
        expect(off.status).toBe(503);
        expect(offOld.status).toBe(503);
        expect(((await off.json()) as { error: { code: string } }).error.code).toBe('ai_off');
      } finally {
        await rig.app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'ai_enabled'`);
      }
    },
  ],
  [
    'B4 POST /api/v1/briefs/{id}/discover',
    async () => {
      const res = await post('discover', `/api/v1/briefs/${st.brief_id}/discover`, undefined, {
        id: st.brief_id!,
      });
      expect(res.status).toBe(200);
      const v1 = await json<{ kind: string }>(res);
      expect(['proposal', 'no_match']).toContain(v1.kind);
      const old = await rig.old(h['oldDiscover']!, sessA, {
        method: 'POST',
        url: '/api/discover',
        body: { need: NEED },
      });
      const o = await json<{ kind: string }>(old);
      expect(shape(v1)).toEqual(shape(o));
      // A brief that does not exist, and a brief of another buyer, answer the same 404.
      expect(
        (
          await post('discover', '/api/v1/briefs/brf_nothing/discover', undefined, {
            id: 'brf_nothing',
          })
        ).status,
      ).toBe(404);
      const other = await rig.key(rig.buyerB, SCOPES);
      const cross = await rig.v1(h['discover']!, other, {
        method: 'POST',
        url: `/api/v1/briefs/${st.brief_id}/discover`,
        params: { id: st.brief_id! },
      });
      expect(cross.status).toBe(404);
    },
  ],
  [
    'B5 POST /api/v1/quotes',
    async () => {
      const page = (await rig.app.engine.offerPage({
        publisher: HARBOUR_TIDE[0],
        offer: HARBOUR_TIDE[1],
      }))!;
      const body = {
        publisher: HARBOUR_TIDE[0],
        offer: HARBOUR_TIDE[1],
        option: page.options[0]!.option,
      };
      const res = await post('quotes', '/api/v1/quotes', body);
      expect(res.status).toBe(200);
      const v1 = await json<{
        kind: string;
        quote_id: string;
        price: { minor: number; currency: string };
      }>(res);
      expect(v1.kind).toBe('quote');
      st.quote_id = v1.quote_id;
      const old = await rig.old(h['oldQuotes']!, sessA, {
        method: 'POST',
        url: '/api/quotes',
        body,
      });
      expect(shape(v1)).toEqual(shape(await old.json()));
      expect(
        (await post('quotes', '/api/v1/quotes', { ...body, offer: 'no-such-offer' })).status,
      ).toBe(404);
      expect((await post('quotes', '/api/v1/quotes', { ...body, extra: 1 })).status).toBe(422);
    },
  ],
  [
    'B6 POST /api/v1/approvals',
    async () => {
      const res = await post('approvals', '/api/v1/approvals', {
        quote_id: st.quote_id,
        consent: CONSENT,
      });
      expect(res.status).toBe(201);
      // The token is in the body, never in a cookie.
      expect(res.headers.get('set-cookie')).toBeNull();
      const v1 = ApprovalIssuedSchema.parse(await res.json());
      expect(v1.token.length).toBeGreaterThanOrEqual(20);
      const page = (await rig.app.engine.offerPage({
        publisher: HARBOUR_TIDE[0],
        offer: HARBOUR_TIDE[1],
      }))!;
      const q2 = await json<{ quote_id: string }>(
        await rig.old(h['oldQuotes']!, sessA, {
          method: 'POST',
          url: '/api/quotes',
          body: {
            publisher: HARBOUR_TIDE[0],
            offer: HARBOUR_TIDE[1],
            option: page.options[0]!.option,
          },
        }),
      );
      const old = await rig.old(h['oldApprovals']!, sessA, {
        method: 'POST',
        url: '/api/approvals',
        body: { quote_id: q2.quote_id, consent: CONSENT },
      });
      expect(old.status).toBe(201);
      const o = await json<Record<string, unknown>>(old);
      for (const k of ['total_minor', 'currency', 'environment'] as const)
        expect(v1[k]).toEqual(o[k]);
      // Consent missing: the same 422 as the old route.
      const noConsent = await post('approvals', '/api/v1/approvals', {
        quote_id: st.quote_id,
        consent: { terms: false, identity_share: false },
      });
      expect(noConsent.status).toBe(422);
      expect((await post('approvals', '/api/v1/approvals', { consent: CONSENT })).status).toBe(422);
    },
  ],
  [
    'B7 POST /api/v1/orders',
    async () => {
      const a = await json<{ approval_id: string; token: string }>(
        await post('approvals', '/api/v1/approvals', { quote_id: st.quote_id, consent: CONSENT }),
      );
      const idem = 'b7-order-idem-key-0001';
      const first = await rig.v1(h['orders']!, tok, {
        method: 'POST',
        url: '/api/v1/orders',
        body: { approval_id: a.approval_id, token: a.token },
        idem,
      });
      expect(first.status).toBe(201);
      const placed = OrderPlacedSchema.parse(await first.json());
      st.order_ref = placed.order_ref;
      const again = await rig.v1(h['orders']!, tok, {
        method: 'POST',
        url: '/api/v1/orders',
        body: { approval_id: a.approval_id, token: a.token },
        idem,
      });
      expect(again.status).toBe(201);
      expect(OrderPlacedSchema.parse(await again.json())).toEqual(placed);
      const rows = await rig.app.db.query('SELECT 1 FROM orders WHERE order_ref = $1', [
        placed.order_ref,
      ]);
      expect(rows.rows).toHaveLength(1);
      // A header is required on a change.
      const none = await rig.v1(h['orders']!, tok, {
        method: 'POST',
        url: '/api/v1/orders',
        body: { approval_id: a.approval_id, token: a.token },
        idem: null,
      });
      expect(none.status).toBe(400);
      // A wrong token: the same answer family as the old route (a refusal, no order).
      const bad = await post('orders', '/api/v1/orders', {
        approval_id: a.approval_id,
        token: 'x'.repeat(40),
      });
      expect([403, 404, 409, 410]).toContain(bad.status);
    },
  ],
  [
    'B8 GET /api/v1/orders',
    async () => {
      st.order_ref_2 = await placeViaV1(QUAY_WALK[0], QUAY_WALK[1]);
      const res = await get('orderList', '/api/v1/orders');
      expect(res.status).toBe(200);
      const all = OrderListSchema.parse(await res.json());
      expect(all.items.map((o) => o.order_ref)).toEqual(
        expect.arrayContaining([st.order_ref!, st.order_ref_2!]),
      );
      const rows = await rig.app.db.query<{ order_ref: string }>(
        `SELECT order_ref FROM orders WHERE buyer_id = $1`,
        [(rig.buyerA as { buyer_id: string }).buyer_id],
      );
      expect(all.items.map((o) => o.order_ref).sort()).toEqual(
        rows.rows.map((r) => r.order_ref).sort(),
      );
      // Newest first, and pages of one cover the set once.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 20; n++) {
        const page: { items: { order_ref: string }[]; next_cursor: string | null } =
          OrderListSchema.parse(
            await (
              await get(
                'orderList',
                `/api/v1/orders?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
              )
            ).json(),
          );
        seen.push(...page.items.map((i) => i.order_ref));
        cursor = page.next_cursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(all.items.map((o) => o.order_ref));
      // Another buyer sees none of these.
      const other = await rig.key(rig.buyerB, SCOPES);
      const theirs = OrderListSchema.parse(
        await (await rig.v1(h['orderList']!, other, { url: '/api/v1/orders' })).json(),
      );
      expect(theirs.items.map((o) => o.order_ref)).not.toContain(st.order_ref);
    },
  ],
  [
    'B9 GET /api/v1/orders/{ref}',
    async () => {
      const res = await get('order', `/api/v1/orders/${st.order_ref}`, { ref: st.order_ref! });
      expect(res.status).toBe(200);
      const v1 = OrderViewSchema.parse(await res.json());
      const old = await rig.old(h['oldOrder']!, sessA, {
        url: `/api/orders/${st.order_ref}`,
        params: { ref: st.order_ref! },
      });
      expect(v1).toEqual(await old.json());
      expect(
        (await get('order', '/api/v1/orders/ord_nothing', { ref: 'ord_nothing' })).status,
      ).toBe(404);
    },
  ],
  [
    'B10 POST /api/v1/orders/{ref}/cancel',
    async () => {
      const res = await post('cancel', `/api/v1/orders/${st.order_ref_2}/cancel`, undefined, {
        ref: st.order_ref_2!,
      });
      expect(res.status).toBe(200);
      const v1 = OrderCancelledSchema.parse(await res.json());
      const ref3 = await placeViaV1(HARBOUR_FERRY[0], HARBOUR_FERRY[1]);
      const old = await rig.old(h['oldCancel']!, sessA, {
        method: 'POST',
        url: `/api/orders/${ref3}/cancel`,
        params: { ref: ref3 },
      });
      expect(old.status).toBe(200);
      expect(shape(v1)).toEqual(shape(await old.json()));
      // Cancelling twice is the same answer; a missing order is 404.
      expect(
        (
          await post('cancel', `/api/v1/orders/${st.order_ref_2}/cancel`, undefined, {
            ref: st.order_ref_2!,
          })
        ).status,
      ).toBeLessThan(500);
      expect(
        (
          await post('cancel', '/api/v1/orders/ord_nothing/cancel', undefined, {
            ref: 'ord_nothing',
          })
        ).status,
      ).toBe(404);
    },
  ],
  [
    'B11 GET /api/v1/library',
    async () => {
      // A paid item for buyer A, made through the Engine (the dry-run checkout is not a v1 item).
      const run = await runPack(rig.app, rig.buyerA, [HARBOUR_FERRY], ['happy']);
      expect(run.returns[0]!.ok).toBe(true);
      const res = await get('library', '/api/v1/library');
      expect(res.status).toBe(200);
      const v1 = LibraryListSchema.parse(await res.json());
      const old = await rig.old(h['oldLibrary']!, sessA, { url: '/api/library' });
      expect(v1.items).toEqual(((await old.json()) as { items: unknown[] }).items);
      expect(v1.next_cursor).toBeNull();
      const ready = v1.items.find((e) => e.can_open);
      expect(ready).toBeDefined();
      st.entitlement_id = ready!.entitlement_id;
      // Another buyer's library does not hold it.
      const other = await rig.key(rig.buyerB, SCOPES);
      const theirs = LibraryListSchema.parse(
        await (await rig.v1(h['library']!, other, { url: '/api/v1/library' })).json(),
      );
      expect(theirs.items.map((e) => e.entitlement_id)).not.toContain(st.entitlement_id);
    },
  ],
  [
    'B12 POST /api/v1/library/{id}/link',
    async () => {
      const res = await post('link', `/api/v1/library/${st.entitlement_id}/link`, undefined, {
        id: st.entitlement_id!,
      });
      expect(res.status).toBe(200);
      const v1 = LinkIssuedSchema.parse(await res.json());
      expect(v1.url.startsWith('/c/')).toBe(true);
      const old = await rig.old(h['oldLink']!, sessA, {
        method: 'POST',
        url: `/api/library/${st.entitlement_id}/link`,
        params: { id: st.entitlement_id! },
        body: {},
      });
      expect(old.status).toBe(200);
      expect(Object.keys(await old.json()).sort()).toEqual(Object.keys(v1).sort());
      expect(
        (await post('link', '/api/v1/library/ent_nothing/link', undefined, { id: 'ent_nothing' }))
          .status,
      ).toBe(404);
      const other = await rig.key(rig.buyerB, SCOPES);
      const cross = await rig.v1(h['link']!, other, {
        method: 'POST',
        url: `/api/v1/library/${st.entitlement_id}/link`,
        params: { id: st.entitlement_id! },
      });
      expect(cross.status).toBe(404);
    },
  ],
];

describe('API-A buyer routes', () => {
  it.each(CASES)('%s', async (_id, run) => {
    await run();
  });
});

describe('API-A buyer routes are registered for the OpenAPI file', () => {
  it('lists B1 to B12 with the scopes the routes need', () => {
    const by = (m: string, p: string) => V1_ROUTES.find((r) => r.method === m && r.path === p);
    const expected: [string, string, string[]][] = [
      ['GET', '/api/v1/catalogue/search', ['catalogue:read']],
      ['GET', '/api/v1/offers/{id}', ['catalogue:read']],
      ['POST', '/api/v1/briefs', ['catalogue:read']],
      ['POST', '/api/v1/briefs/{id}/discover', ['catalogue:read']],
      ['POST', '/api/v1/quotes', ['orders:write']],
      ['POST', '/api/v1/approvals', ['orders:write']],
      ['POST', '/api/v1/orders', ['orders:write']],
      ['GET', '/api/v1/orders', ['orders:read']],
      ['GET', '/api/v1/orders/{ref}', ['orders:read']],
      ['POST', '/api/v1/orders/{ref}/cancel', ['orders:write']],
      ['GET', '/api/v1/library', ['library:read']],
      ['POST', '/api/v1/library/{id}/link', ['library:read']],
    ];
    for (const [m, p, scopes] of expected) {
      const r = by(m, p);
      expect(r, `${m} ${p}`).toBeDefined();
      expect(r!.auth).toBe('apikey');
      expect([...r!.scopes]).toEqual(scopes);
    }
  });
});
