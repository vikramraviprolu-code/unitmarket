// API-A end to end, through the real route modules on a booted offline app (dry-run transport). A buyer
// key goes search, quote, approval, order, dry-run checkout, library link, and the order is paid; a seller
// key creates, revises and withdraws an offer and sees the sale. `fetch`, `net.connect` and `dns.lookup`
// throw in this file and the run must end with zero recorded calls.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CatalogueSearchResponseSchema,
  LibraryListSchema,
  OrderPlacedSchema,
  OrderViewSchema,
  SellerOfferResultSchema,
  SellerSalesSchema,
} from '@umsbx/contracts';
import { bootA, json, type ARig, type Handler } from '../../../api-v1/a-support';
import { expectOffline, offlineTrace } from '../../../api-v1/offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

let rig: ARig;
const h: Record<string, Handler> = {};
const CONSENT = { terms: true, identity_share: false };

beforeAll(async () => {
  rig = await bootA();
  h['search'] = (await import('./catalogue/search/route')).GET as Handler;
  h['quotes'] = (await import('./quotes/route')).POST as Handler;
  h['approvals'] = (await import('./approvals/route')).POST as Handler;
  h['orders'] = (await import('./orders/route')).POST as Handler;
  h['order'] = (await import('./orders/[ref]/route')).GET as Handler;
  h['library'] = (await import('./library/route')).GET as Handler;
  h['link'] = (await import('./library/[id]/link/route')).POST as Handler;
  const offers = await import('./seller/offers/route');
  h['sellerCreate'] = offers.POST as Handler;
  h['sellerList'] = offers.GET as Handler;
  const one = await import('./seller/offers/[id]/route');
  h['sellerRevise'] = one.PATCH as Handler;
  h['sellerWithdraw'] = one.DELETE as Handler;
  h['sales'] = (await import('./seller/sales/route')).GET as Handler;
});

describe('flow A: a buyer key buys through /api/v1', () => {
  it('search, quote, approval, order, dry-run checkout, library link: the order is paid', async () => {
    const tok = await rig.key(rig.buyerA, [
      'catalogue:read',
      'orders:read',
      'orders:write',
      'library:read',
    ]);
    const v1 = (name: string, r: Parameters<ARig['v1']>[2]) => rig.v1(h[name]!, tok, r);

    const found = CatalogueSearchResponseSchema.parse(
      await (await v1('search', { url: '/api/v1/catalogue/search?q=tide%20tables' })).json(),
    );
    expect(found.items.length).toBeGreaterThan(0);
    const pick = found.items.find(
      (i) => i.publisher_slug === 'harbour-ledger' && i.offer_code === 'tide-tables',
    )!;
    expect(pick).toBeDefined();

    const q = await json<{ kind: string; quote_id: string }>(
      await v1('quotes', {
        method: 'POST',
        url: '/api/v1/quotes',
        body: {
          publisher: pick.publisher_slug,
          offer: pick.offer_code,
          option: pick.options[0]!.option,
        },
      }),
    );
    expect(q.kind).toBe('quote');

    const ares = await v1('approvals', {
      method: 'POST',
      url: '/api/v1/approvals',
      body: { quote_id: q.quote_id, consent: CONSENT },
    });
    expect(ares.status).toBe(201);
    const a = await json<{ approval_id: string; token: string; total_minor: number }>(ares);
    expect(a.total_minor).toBe(pick.options[0]!.price_minor);

    const ores = await v1('orders', {
      method: 'POST',
      url: '/api/v1/orders',
      body: { approval_id: a.approval_id, token: a.token },
    });
    expect(ores.status).toBe(201);
    const placed = OrderPlacedSchema.parse(await ores.json());

    // The dry-run checkout is the pretend PayPal of the app; it is not a v1 route.
    const co = await rig.app.engine.payments.beginCheckout({
      order_id: placed.order_id,
      actor: rig.buyerA,
    });
    expect(co.ok).toBe(true);
    expect(
      await rig.app.engine.dryRunApprove({
        order_ref: placed.order_ref,
        actor: rig.buyerA,
        scenario: 'happy',
      }),
    ).toBe(true);
    const back = await rig.app.engine.payments.onBuyerReturn({
      order_ref: placed.order_ref,
      actor: rig.buyerA,
      scenario: null,
    });
    expect(back.ok).toBe(true);

    const view = OrderViewSchema.parse(
      await (
        await v1('order', {
          url: `/api/v1/orders/${placed.order_ref}`,
          params: { ref: placed.order_ref },
        })
      ).json(),
    );
    expect(view.status).toBe('paid');
    expect(view.environment).toBe('dryrun');

    const lib = LibraryListSchema.parse(
      await (await v1('library', { url: '/api/v1/library' })).json(),
    );
    const item = lib.items.find((e) => e.order_ref === placed.order_ref);
    expect(item).toBeDefined();
    expect(item!.can_open).toBe(true);
    const link = await v1('link', {
      method: 'POST',
      url: `/api/v1/library/${item!.entitlement_id}/link`,
      params: { id: item!.entitlement_id },
    });
    expect(link.status).toBe(200);
    expect(((await link.json()) as { url: string }).url).toMatch(/^\/c\//);
  });
});

describe('flow A: a seller key sells through /api/v1', () => {
  it('creates, revises and withdraws an offer, and sees the sale', async () => {
    const tok = await rig.key(rig.harbour, ['catalogue:read', 'offers:write', 'sales:read']);
    const v1 = (name: string, r: Parameters<ARig['v1']>[2]) => rig.v1(h[name]!, tok, r);
    const pubId = (rig.harbour as { publisher_id: string }).publisher_id;
    await rig.app.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ('art_flow_a',$1,'Flow A','An abstract.','en',ARRAY['t'],'2026-10-21T10:00:00Z',$2,'flow/a',1,'text/plain','2026-10-21T10:00:00Z','2026-10-21T10:00:00Z')`,
      [pubId, 'd'.repeat(64)],
    );
    const prices = (k: number, r: number) => [
      { option: 'keep_retrieve', price_minor: k },
      { option: 'online_read', price_minor: r },
    ];
    const created = SellerOfferResultSchema.parse(
      await (
        await v1('sellerCreate', {
          method: 'POST',
          url: '/api/v1/seller/offers',
          body: { article_id: 'art_flow_a', options: prices(150, 100), attestation: true },
        })
      ).json(),
    );
    const revised = SellerOfferResultSchema.parse(
      await (
        await v1('sellerRevise', {
          method: 'PATCH',
          url: `/api/v1/seller/offers/${created.offer_id}`,
          params: { id: created.offer_id },
          body: { expected_version: created.version, options: prices(170, 110), attestation: true },
        })
      ).json(),
    );
    expect(revised.version).not.toBe(created.version);

    // A buyer sells nothing here: the sale of an existing harbour offer shows in the seller's sales.
    const buyerTok = await rig.key(rig.buyerB, ['catalogue:read', 'orders:read', 'orders:write']);
    const page = (await rig.app.engine.offerPage({
      publisher: 'harbour-ledger',
      offer: 'tide-tables',
    }))!;
    const q = await json<{ quote_id: string }>(
      await rig.v1(h['quotes']!, buyerTok, {
        method: 'POST',
        url: '/api/v1/quotes',
        body: {
          publisher: 'harbour-ledger',
          offer: 'tide-tables',
          option: page.options[0]!.option,
        },
      }),
    );
    const a = await json<{ approval_id: string; token: string }>(
      await rig.v1(h['approvals']!, buyerTok, {
        method: 'POST',
        url: '/api/v1/approvals',
        body: { quote_id: q.quote_id, consent: CONSENT },
      }),
    );
    const placed = OrderPlacedSchema.parse(
      await (
        await rig.v1(h['orders']!, buyerTok, {
          method: 'POST',
          url: '/api/v1/orders',
          body: { approval_id: a.approval_id, token: a.token },
        })
      ).json(),
    );
    await rig.app.engine.payments.beginCheckout({ order_id: placed.order_id, actor: rig.buyerB });
    await rig.app.engine.dryRunApprove({
      order_ref: placed.order_ref,
      actor: rig.buyerB,
      scenario: 'happy',
    });
    await rig.app.engine.payments.onBuyerReturn({
      order_ref: placed.order_ref,
      actor: rig.buyerB,
      scenario: null,
    });

    const sales = SellerSalesSchema.parse(
      await (await v1('sales', { url: '/api/v1/seller/sales' })).json(),
    );
    expect(sales.items.some((s) => s.order_ref6 === placed.order_ref.slice(-6))).toBe(true);

    const wd = await v1('sellerWithdraw', {
      method: 'DELETE',
      url: `/api/v1/seller/offers/${created.offer_id}?expected_version=${revised.version}&reason=${encodeURIComponent('flow complete')}`,
      params: { id: created.offer_id },
    });
    expect(wd.status).toBe(200);
    const listed = await json<{ items: { offer_id: string; status: string }[] }>(
      await v1('sellerList', { url: '/api/v1/seller/offers' }),
    );
    expect(listed.items.find((o) => o.offer_id === created.offer_id)?.status).toBe('withdrawn');
  });
});

describe('flow A: offline', () => {
  it('nothing reached fetch, a socket or a name lookup during the flows above', () => {
    expect(offlineTrace.calls).toEqual([]);
  });
});
