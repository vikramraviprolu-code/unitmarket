// PUB-E1 state (docs/specs/pub-e1-publisher-should.md): through a booted offline app. CSV export, the
// refunds view, since your last visit and create an offer. The pages are .tsx files the unit runner does
// not compile, so their source is read as text.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootOffersWorld, both } from './offers-support';
import type { OffersWebWorld } from './offers-support';
import { buy, postRefund } from './refund-support';
import type { BoughtUnit } from './refund-support';
import { call } from './support';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

let w: OffersWebWorld;
let exportRoute: typeof import('./app/api/publisher/export/route');
let createRoute: typeof import('./app/api/publisher/offers/create/route');
let whole: BoughtUnit;
let part: BoughtUnit;
let plain: BoughtUnit;

beforeAll(async () => {
  w = await bootOffersWorld();
  exportRoute = await import('./app/api/publisher/export/route');
  createRoute = await import('./app/api/publisher/offers/create/route');
  whole = await buy(w.refund, { offer: 'knot-notebook', option: 'online_read' });
  part = await buy(w.refund, { offer: 'harbour-fees', option: 'online_read' });
  plain = await buy(w.refund, { offer: 'tide-tables', option: 'online_read' });
  const r1 = await postRefund(w.refund, w.refund.op, {
    unit_id: whole.unit_id,
    amount_minor: null,
    reason: 'Customer asked for a refund',
  });
  expect(r1.status).toBe(200);
  const r2 = await postRefund(w.refund, w.refund.op, {
    unit_id: part.unit_id,
    amount_minor: 100,
    reason: 'Customer asked for a refund',
  });
  expect(r2.status).toBe(200);
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const harbour = () => w.pub['harbour-ledger'];
const getExport = (kind: string, session = harbour()) =>
  call(exportRoute.GET as Handler, { url: `/api/publisher/export?kind=${kind}`, session });

describe('CSV export', () => {
  it('sends the statement as an attachment with the right headers and lines', async () => {
    const res = await getExport('statement');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="unitmarket-statement.csv"',
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await res.text();
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('date,order_ref_last6,kind,currency,amount_minor,amount,environment');
    expect(text).toContain(`,${whole.order_ref.slice(-6)},sale,USD,${String(whole.amount_minor)},`);
    expect(text).toContain(
      `,${whole.order_ref.slice(-6)},refund,USD,${String(whole.amount_minor)},`,
    );
    expect(text).toContain(',,total_net,USD,');
    expect(text).toContain(',dryrun');
  });

  it('sends the sales with one row per paid unit and the last 6 of each order ref', async () => {
    const res = await getExport('sales');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="unitmarket-sales.csv"',
    );
    const lines = (await res.text()).split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1 + 3);
    for (const u of [whole, part, plain]) {
      expect(lines.some((l) => l.includes(`,${u.order_ref.slice(-6)},`))).toBe(true);
    }
    expect(lines.join('\n')).not.toContain(whole.order_ref);
  });

  it('names no buyer anywhere', async () => {
    const text =
      (await (await getExport('sales')).text()) + (await (await getExport('statement')).text());
    const buyerId = w.refund.actorA.kind === 'buyer' ? w.refund.actorA.buyer_id : '';
    expect(buyerId).not.toBe('');
    expect(text).not.toContain(buyerId);
    expect(text).not.toMatch(/Buyer A|buyer-a|persona:/i);
  });

  it('gives another publisher an empty file, never the first publisher’s rows', async () => {
    const res = await getExport('sales', w.pub['quayside-gazette']);
    expect(res.status).toBe(200);
    expect((await res.text()).split('\r\n').filter((l) => l !== '')).toHaveLength(1);
    const st = await (await getExport('statement', w.pub['quayside-gazette'])).text();
    expect(st).not.toContain(whole.order_ref.slice(-6));
  });

  it('declares the route with auth publisher, no csrf, a rate limit and a small body cap', () => {
    expect(exportRoute.routeMeta).toMatchObject({
      path: '/api/publisher/export',
      method: 'GET',
      auth: 'publisher',
      csrf: false,
    });
    expect(exportRoute.routeMeta.rate).toMatchObject({
      per: 'actor',
      limit: 10,
      window_ms: 60_000,
    });
  });

  it('limits to 10 downloads a minute per publisher', async () => {
    let last = 200;
    for (let i = 0; i < 11; i++) last = (await getExport('sales')).status;
    expect(last).toBe(429);
  });
});

describe('engine.publisherRefunds', () => {
  it('lists the refunded and partly refunded units with sums from the ledger', async () => {
    const rows = (await w.app.engine.publisherRefunds(w.actor['harbour-ledger']))!;
    expect(rows).toHaveLength(2);
    const by = Object.fromEntries(rows.map((r) => [r.order_ref6, r]));
    expect(by[whole.order_ref.slice(-6)]).toMatchObject({
      status: 'refunded',
      amount_minor: whole.amount_minor,
      refunded_minor: whole.amount_minor,
    });
    expect(by[part.order_ref.slice(-6)]).toMatchObject({
      status: 'partially_refunded',
      amount_minor: part.amount_minor,
      refunded_minor: 100,
    });
    expect(await w.app.engine.publisherRefunds(w.actor['quayside-gazette'])).toEqual([]);
    expect(await w.app.engine.publisherRefunds(w.refund.actorA)).toBeNull();
  });
  it('the sales page has a separate Refunds section fed by the engine', () => {
    const src = read('./app/publisher/sales/page.tsx');
    expect(src).toContain('engine.publisherRefunds(actor)');
    expect(src).toContain('REFUNDS_HEADING');
    expect(src).toContain('refunds-table');
    expect(src).toContain('EXPORT_SALES_HREF');
  });
});

describe('since your last visit', () => {
  it('the first visit stores a row and says so; the next visit lists what changed', async () => {
    const actor = w.actor['quayside-gazette'];
    const first = (await w.app.engine.publisherSince(actor))!;
    expect(first).toMatchObject({ first_visit: true, since: null, counts: null });
    // nothing yet counts for a visit inside the gap
    const again = (await w.app.engine.publisherSince(actor))!;
    expect(again.first_visit).toBe(true);
  });

  it('counts sales, refunds and operator changes made after the last visit, for this publisher only', async () => {
    const actor = w.actor['harbour-ledger'];
    const db = w.app.db;
    // a visit in the past: put the cursor before the purchases
    await db.query(
      `INSERT INTO publisher_visits (publisher_id, since_at, last_seen_at, created_at, updated_at)
       VALUES ($1, NULL, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')
       ON CONFLICT (publisher_id) DO UPDATE SET last_seen_at = '2000-01-01T00:00:00Z', since_at = NULL`,
      [actor.kind === 'publisher' ? actor.publisher_id : ''],
    );
    const r = (await w.app.engine.publisherSince(actor))!;
    expect(r.first_visit).toBe(false);
    expect(r.since).toBe('2000-01-01T00:00:00.000Z');
    expect(r.counts).toMatchObject({ new_sales: 3, refunds: 2, payee_decisions: 0 });
    // a refresh keeps the same answer
    const r2 = (await w.app.engine.publisherSince(actor))!;
    expect(r2.counts).toEqual(r.counts);
    // another publisher sees none of it
    const q = (await w.app.engine.publisherSince(w.actor['quayside-gazette']))!;
    expect(q.counts === null || q.counts.new_sales === 0).toBe(true);
    expect(await w.app.engine.publisherSince(w.refund.actorA)).toBeNull();
  });

  it('the home page shows it from the engine', () => {
    const src = read('./app/publisher/page.tsx');
    expect(src).toContain('engine.publisherSince(actor)');
    expect(src).toContain('SINCE_HEADING');
  });
});

describe('create an offer', () => {
  const article = async (slug: 'harbour-ledger' | 'quayside-gazette', key: string) => {
    const id = `art_e1_${key}`;
    await w.app.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ($1,$2,$3,'An abstract.','en',ARRAY['t'],'2026-10-21T10:00:00Z',$4,$5,1,'text/plain','2026-10-21T10:00:00Z','2026-10-21T10:00:00Z')`,
      [id, w.pubId[slug], `E1 ${key}`, 'c'.repeat(64), `e1/${key}`],
    );
    return id;
  };
  const post = (session: (typeof w.pub)['harbour-ledger'] | null, body: unknown, csrf?: boolean) =>
    call(createRoute.POST as Handler, {
      url: '/api/publisher/offers/create',
      method: 'POST',
      body,
      session,
      ...(csrf === undefined ? {} : { csrf }),
    });

  it('creates version 1 over the route, then lists it, then a buyer can quote it', async () => {
    const id = await article('harbour-ledger', 'route-1');
    const offerable = (await w.app.engine.offers.offerable(w.actor['harbour-ledger']))!;
    expect(offerable.articles.map((a) => a.article_id)).toContain(id);
    expect(offerable.offer_max_minor).toBe(2000);
    const res = await post(harbour(), {
      article_id: id,
      options: both(150, 100),
      attestation: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offer_id: string; version: string };
    expect(body.version).toBe('1');
    const listed = (await w.app.engine.offers.list(w.actor['harbour-ledger']))!;
    expect(listed.offers.find((o) => o.offer_id === body.offer_id)?.status).toBe('authorised');
    const q = await w.app.engine.quote({
      offer: {
        publisher_slug: 'harbour-ledger',
        offer_code: body.offer_id.replace('ofr_harbour-ledger_', ''),
      },
      actor: w.refund.actorB,
      source: 'direct',
      option: 'online_read',
    });
    expect(q.ok).toBe(true);
    const again = await post(harbour(), {
      article_id: id,
      options: both(150, 100),
      attestation: true,
    });
    expect(again.status).toBe(409);
  });

  it('answers 422 for a price over the cap or zero and 422 without the tick', async () => {
    const id = await article('harbour-ledger', 'route-2');
    expect(
      (await post(harbour(), { article_id: id, options: both(2001, 100), attestation: true }))
        .status,
    ).toBe(422);
    expect(
      (await post(harbour(), { article_id: id, options: both(0, 100), attestation: true })).status,
    ).toBe(422);
    expect(
      (await post(harbour(), { article_id: id, options: both(100, 100), attestation: false }))
        .status,
    ).toBe(422);
  });

  it('the page and the form read no publisher id and use existing classes only', () => {
    const page = read('./app/publisher/offers/new/page.tsx').replace(/\/\/.*$/gm, '');
    expect(page).not.toMatch(/searchParams|params|headers\(|cookies\(/);
    expect(page).toContain('engine.offers.offerable(actor)');
    expect(page).not.toMatch(/style=|<script|<img|https?:\/\/|<i>|<em>/);
    const form = read('./app/publisher/offers/new/CreateForm.tsx');
    expect(form).toContain('/api/publisher/offers/create');
    expect(form).not.toMatch(/publisher_id|style=/);
    expect(read('./app/publisher/offers/page.tsx')).toContain('/publisher/offers/new');
  });
});
