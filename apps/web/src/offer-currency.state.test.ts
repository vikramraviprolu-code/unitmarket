// OFFER-CUR (docs/specs/catalogue-offer-currency.md): the seller chooses the currency of an offer, through the
// real routes and engine over the dry-run order model. Today's rows come first (nothing changes); the rows of the
// coming migration 0034 are simulated by inserting wide corridors. Dry run: this proves the modelled path, not
// PayPal compatibility. No PayPal, no socket, synthetic ids.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer, proposalFor, HARBOUR_TIDE } from './composite-support';
import { call, signIn } from './support';
import type { Session } from './support';
import { createApproval as createApprovalV1, createQuote } from './api-v1/buyer';
import { createOffer as createOfferV1 } from './api-v1/seller';
import { installWideCorridors } from './wide-corridors-support';
import { CORRIDOR_UNSUPPORTED_SINGLE_TEXT, CORRIDOR_UNSUPPORTED_TEXT } from './lib/composite-copy';
import type { App } from '../composition.server';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let app: App;
let A: Actor;
let SA: Session;
let createRoute: typeof import('./app/api/publisher/offers/create/route');
let approvalsRoute: typeof import('./app/api/approvals/route');
let receiptsRoute: typeof import('./app/api/receipts/[order]/route');
let exportRoute: typeof import('./app/api/publisher/export/route');
const pubs: Record<string, { actor: Actor; session: Session }> = {};
let seq = 0;

const AT = '2026-10-21T10:00:00Z';
async function addPublisher(slug: string, country: string, code: string): Promise<void> {
  const id = `pub_${slug.replace(/-/g, '_')}`;
  await app.db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, paypal_merchant_id, payee_verified_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$6,$6,$6)`,
    [id, slug, `${slug} (fictional)`, country, code, AT],
  );
  const actor: Actor = { kind: 'publisher', publisher_id: id };
  const s = await createSession(app.security, actor);
  pubs[slug] = { actor, session: { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token } };
}
async function addArticle(slug: string): Promise<string> {
  seq += 1;
  const id = `art_oc_${String(seq)}`;
  const owner = pubs[slug]!.actor;
  // The bytes the unit delivers: a stored blob whose hash matches the article, so the buy can complete.
  const bytes = Buffer.from(`Synthetic fictional article ${String(seq)}.`, 'utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const contentKey = `oc/${String(seq)}`;
  await app.db.query(
    `INSERT INTO content_blobs (content_key, sha256, mime, bytes, data, created_at, updated_at)
     VALUES ($1,$2,'text/plain',$3,$4,$5,$5)`,
    [contentKey, sha, bytes.length, bytes, AT],
  );
  await app.db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ($1,$2,$3,'An abstract.','en',ARRAY['t'],$4,$5,$6,$7,'text/plain',$4,$4)`,
    [
      id,
      owner.kind === 'publisher' ? owner.publisher_id : '',
      `OC ${String(seq)}`,
      AT,
      sha,
      contentKey,
      bytes.length,
    ],
  );
  return id;
}
const both = (keep: number, online: number) => [
  { option: 'keep_retrieve' as const, price_minor: keep },
  { option: 'online_read' as const, price_minor: online },
];
/** Create over the old route; returns the response. */
async function postCreate(slug: string, currency?: unknown, article?: string): Promise<Response> {
  return call(createRoute.POST as Handler, {
    url: '/api/publisher/offers/create',
    method: 'POST',
    session: pubs[slug]!.session,
    body: {
      article_id: article ?? (await addArticle(slug)),
      options: both(150, 100),
      attestation: true,
      ...(currency === undefined ? {} : { currency }),
    },
  });
}
async function made(slug: string, currency?: string): Promise<{ id: string; code: string }> {
  const res = await postCreate(slug, currency);
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { offer_id: string }).offer_id;
  return { id, code: id.replace(`ofr_${slug}_`, '') };
}
const currencyOfOffer = async (id: string): Promise<string> =>
  (await app.db.query<{ currency: string }>('SELECT currency FROM offers WHERE id = $1', [id]))
    .rows[0]!.currency;
const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await app.db.query<{ c: string | number }>(sql, p)).rows[0]!.c);
const codeOf = async (res: Response): Promise<string> =>
  ((await res.clone().json()) as { error: { code: string } }).error.code;

/** The discovery candidate rule of listAuthorisedOffers, read straight from the rows: enabled corridor, its currency and its payee countries. */
async function candidateIds(corridorId: string): Promise<string[]> {
  const r = await app.db.query<{ id: string }>(
    `SELECT o.id FROM offers o
       JOIN publishers p ON p.id = o.publisher_id
       JOIN corridors c ON c.id = $1 AND c.enabled
      WHERE o.status = 'authorised' AND o.superseded_by IS NULL AND p.status = 'active'
        AND o.currency = c.currency AND p.country = ANY (c.payee_countries)
        AND EXISTS (SELECT 1 FROM publisher_authorisations pa WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
        AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND (n.created_at, n.version) > (o.created_at, o.version))
      ORDER BY o.id`,
    [corridorId],
  );
  return r.rows.map((x) => x.id);
}

/** The buyer's whole payment of one offer through the engine; returns the order id. */
async function pay(actor: Actor, slug: string, code: string): Promise<string> {
  const q = await app.engine.quote({
    offer: { publisher_slug: slug, offer_code: code },
    actor,
    source: 'direct',
    option: 'online_read',
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote: ${JSON.stringify(q)}`);
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  expect(
    await app.engine.dryRunApprove({ order_ref: placed.value.order_ref, actor, scenario: 'happy' }),
  ).toBeTruthy();
  await app.engine.payments.onBuyerReturn({
    order_ref: placed.value.order_ref,
    actor,
    scenario: 'happy',
  });
  return placed.value.order_id;
}

beforeAll(async () => {
  app = await bootPackApp();
  A = await buyer(app, 'a');
  const sessionRoute = await import('./app/api/session/route');
  SA = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  createRoute = await import('./app/api/publisher/offers/create/route');
  approvalsRoute = await import('./app/api/approvals/route');
  receiptsRoute = await import('./app/api/receipts/[order]/route');
  exportRoute = await import('./app/api/publisher/export/route');
  const id = (slug: string): Promise<string> =>
    app.db
      .query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
      .then((r) => r.rows[0]!.id);
  const harbour: Actor = { kind: 'publisher', publisher_id: await id('harbour-ledger') };
  const hs = await createSession(app.security, harbour);
  pubs['harbour-ledger'] = {
    actor: harbour,
    session: { cookie: hs.cookie.split(';')[0] ?? '', csrf: hs.csrf_token },
  };
  await addPublisher('paris-desk', 'FR', 'DRYRUNFRPUB01');
  await addPublisher('delhi-desk', 'IN', 'DRYRUNINPUB01');
  await app.db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ('buy_in_1', 'India buyer', 'test:in-1', 'IN', now(), now())`,
  );
});
afterAll(async () => {
  await app.close();
});

describe('today: only USD covers the US and India (nothing changes)', () => {
  beforeEach(async () => {
    // models today's live data: migration 0034 made the rows wide, so narrow them back here
    await app.db.query(
      "UPDATE corridors SET enabled = false WHERE id <> 'us-usd' AND id <> 'in-usd'",
    );
    await app.db.query("UPDATE corridors SET payee_countries = ARRAY['US'] WHERE id = 'us-usd'");
  });

  it('the new offer page lists one currency, USD, for a US publisher', async () => {
    const v = (await app.engine.offers.offerable(pubs['harbour-ledger']!.actor))!;
    expect(v.currency).toBe('USD');
    expect(v.currencies).toEqual(['USD']);
    const inv = (await app.engine.offers.offerable(pubs['delhi-desk']!.actor))!;
    expect(inv.currencies).toEqual(['USD']);
  });

  it('create without a currency, and with USD, gives a USD offer for US and India', async () => {
    for (const slug of ['harbour-ledger', 'delhi-desk']) {
      expect(await currencyOfOffer((await made(slug)).id)).toBe('USD');
      expect(await currencyOfOffer((await made(slug, 'USD')).id)).toBe('USD');
    }
  });

  it('EUR and GBP are refused as no_corridor (422); a code outside the three is refused at the door', async () => {
    for (const c of ['EUR', 'GBP']) {
      const res = await postCreate('harbour-ledger', c);
      expect(res.status).toBe(422);
      expect(await codeOf(res)).toBe('no_corridor');
    }
    for (const bad of ['JPY', 'usd', 123, null]) {
      const res = await postCreate('harbour-ledger', bad);
      expect([400, 422]).toContain(res.status);
    }
  });

  it('an India offer and a US offer in one basket give corridor_unsupported with the new words', async () => {
    const inOffer = await made('delhi-desk');
    const before = await count('SELECT count(*) AS c FROM approvals');
    const p = await proposalFor(app, A, [HARBOUR_TIDE, ['delhi-desk', inOffer.code]]);
    const res = await call(approvalsRoute.POST as Handler, {
      url: '/api/approvals',
      method: 'POST',
      session: SA,
      body: {
        proposal_id: p.proposal_id,
        offer_ids: p.offer_ids,
        consent: { terms: true, identity_share: false },
      },
    });
    expect(res.status).toBe(422);
    const b = (await res.json()) as { error: { code: string; message: string } };
    expect(b.error.code).toBe('corridor_unsupported');
    expect(b.error.message).toBe(CORRIDOR_UNSUPPORTED_TEXT);
    expect(CORRIDOR_UNSUPPORTED_TEXT).toBe(
      'Items from publishers in India are paid separately. Buy them in a separate order.',
    );
    expect(await count('SELECT count(*) AS c FROM approvals')).toBe(before);
  });

  it('the same two-item basket through the v1 door gives the India words too', async () => {
    const inOffer = await made('delhi-desk');
    const p = await proposalFor(app, A, [HARBOUR_TIDE, ['delhi-desk', inOffer.code]]);
    const ctx = { actor: A, principal: { kind: 'api_client' } as never };
    const r = await createApprovalV1(app, ctx, {
      proposal_id: p.proposal_id,
      offer_ids: p.offer_ids,
      consent: { terms: true, identity_share: false },
    });
    expect(r.status).toBe(422);
    const e = r as { code?: string; message?: string };
    expect(e.code).toBe('corridor_unsupported');
    expect(e.message).toBe(CORRIDOR_UNSUPPORTED_TEXT);
  });
});

describe('with the rows of migration 0034 (simulated)', () => {
  beforeEach(async () => {
    await installWideCorridors(app.db);
  });

  it('the new offer page lists USD, EUR, GBP with USD the default', async () => {
    for (const slug of ['harbour-ledger', 'paris-desk', 'delhi-desk']) {
      const v = (await app.engine.offers.offerable(pubs[slug]!.actor))!;
      expect(v.currencies).toEqual(['USD', 'EUR', 'GBP']);
      expect(v.currency).toBe('USD');
    }
  });

  it('create with no currency is USD for US, FR and India publishers (deploy window, never EUR)', async () => {
    for (const slug of ['harbour-ledger', 'paris-desk', 'delhi-desk'])
      expect(await currencyOfOffer((await made(slug)).id)).toBe('USD');
  });

  it('the old route and the v1 seller route both take the chosen currency', async () => {
    expect(await currencyOfOffer((await made('paris-desk', 'GBP')).id)).toBe('GBP');
    expect(await currencyOfOffer((await made('delhi-desk', 'EUR')).id)).toBe('EUR');
    const ctx = {
      actor: pubs['paris-desk']!.actor,
      principal: { kind: 'api_client' } as never,
    };
    const r = await createOfferV1(app, ctx, {
      article_id: await addArticle('paris-desk'),
      options: both(150, 100),
      attestation: true,
      currency: 'EUR',
    });
    expect(r.status).toBe(201);
    expect(
      await currencyOfOffer(((r as { body?: unknown }).body as { offer_id: string }).offer_id),
    ).toBe('EUR');
  });

  it('a chosen currency with no enabled corridor for the country is refused', async () => {
    await app.db.query("UPDATE corridors SET enabled = false WHERE id = 'in-gbp'");
    const res = await postCreate('delhi-desk', 'GBP');
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('no_corridor');
  });

  it('one item whose corridor goes off after the quote gets the neutral words, not the India words, on both doors', async () => {
    const o = await made('paris-desk', 'EUR');
    const quoteId = async (): Promise<string> => {
      const q = await app.engine.quote({
        offer: { publisher_slug: 'paris-desk', offer_code: o.code },
        actor: A,
        source: 'direct',
        option: 'online_read',
      });
      if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
      return q.value.quote_id;
    };
    const viaRoute = await quoteId();
    const viaV1 = await quoteId();
    await app.db.query("UPDATE corridors SET enabled = false WHERE currency = 'EUR'");
    const consent = { terms: true, identity_share: false };
    const res = await call(approvalsRoute.POST as Handler, {
      url: '/api/approvals',
      method: 'POST',
      session: SA,
      body: { quote_id: viaRoute, consent },
    });
    expect(res.status).toBe(422);
    const b = (await res.json()) as { error: { code: string; message: string } };
    expect(b.error.code).toBe('corridor_unsupported');
    expect(b.error.message).toBe(CORRIDOR_UNSUPPORTED_SINGLE_TEXT);
    expect(b.error.message).not.toContain('India');
    const ctx = { actor: A, principal: { kind: 'api_client' } as never };
    const r = await createApprovalV1(app, ctx, { quote_id: viaV1, consent });
    expect(r.status).toBe(422);
    const e = r as { code?: string; message?: string };
    expect(e.code).toBe('corridor_unsupported');
    expect(e.message).toBe(CORRIDOR_UNSUPPORTED_SINGLE_TEXT);
    expect(CORRIDOR_UNSUPPORTED_SINGLE_TEXT).toBe(
      'This item cannot be paid for right now. Please try again later.',
    );
  });

  it('an FR publisher GBP offer is bought by a US buyer in GBP from quote to statement', async () => {
    const o = await made('paris-desk', 'GBP');
    const q = await app.engine.quote({
      offer: { publisher_slug: 'paris-desk', offer_code: o.code },
      actor: A,
      source: 'direct',
      option: 'online_read',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    expect(q.value.price).toEqual({ currency: 'GBP', minor: 100 });
    expect(q.value.corridor_id).toBe('gb-gbp');
    const g = await app.engine.requestApproval({
      actor: A,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
    expect(g.value.snapshot.currency).toBe('GBP');
    const snap = (
      await app.db.query<{ snapshot: unknown }>('SELECT snapshot FROM approvals WHERE id = $1', [
        g.value.approval_id,
      ])
    ).rows[0]!.snapshot;
    expect(JSON.stringify(snap)).toContain('gb-gbp');

    const placed = await app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor: A,
    });
    if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
    await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor: A });
    await app.engine.dryRunApprove({
      order_ref: placed.value.order_ref,
      actor: A,
      scenario: 'happy',
    });
    await app.engine.payments.onBuyerReturn({
      order_ref: placed.value.order_ref,
      actor: A,
      scenario: 'happy',
    });

    const order = (
      await app.db.query<{ currency: string; status: string }>(
        'SELECT currency, status FROM orders WHERE id = $1',
        [placed.value.order_id],
      )
    ).rows[0]!;
    expect(order).toEqual({ currency: 'GBP', status: 'paid' });
    const ledger = await app.db.query<{
      currency: string;
      kind: string;
      amount_minor: string | number;
    }>(
      `SELECT l.kind, l.currency, l.amount_minor FROM ledger_entries l
         JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1`,
      [placed.value.order_id],
    );
    expect(ledger.rows.length).toBeGreaterThan(0);
    expect([...new Set(ledger.rows.map((r) => r.currency))]).toEqual(['GBP']);
    const receipt = await call(receiptsRoute.GET as Handler, {
      url: `/api/receipts/${placed.value.order_id}`,
      session: SA,
      params: { order: placed.value.order_id },
    });
    expect(receipt.status).toBe(200);
    const text = await receipt.text();
    expect(text).toContain('GBP');
    expect(text).not.toContain('USD');
    const st = await call(exportRoute.GET as Handler, {
      url: '/api/publisher/export?kind=statement',
      session: pubs['paris-desk']!.session,
    });
    const csv = ((await st.json()) as { csv: string }).csv;
    expect(csv).toContain(`,${placed.value.order_ref.slice(-6)},sale,GBP,100,`);
    expect(csv).not.toContain(',USD,');
  });

  it('an India EUR offer: an India buyer is refused with no stored quote, a US buyer is quoted in in-eur', async () => {
    const o = await made('delhi-desk', 'EUR');
    const inBuyer: Actor = { kind: 'buyer', buyer_id: 'buy_in_1' };
    const offer = { publisher_slug: 'delhi-desk', offer_code: o.code };
    const before = await count('SELECT count(*) AS c FROM quotes');
    const refused = await app.engine.quote({ offer, actor: inBuyer, source: 'direct' });
    expect(refused.ok && refused.value.kind === 'no_match' && refused.value.reason).toBe(
      'corridor_unsupported',
    );
    expect(await count('SELECT count(*) AS c FROM quotes')).toBe(before);
    // the agent / v1 path is the same engine call
    const ctx = { actor: inBuyer, principal: { kind: 'api_client' } as never };
    const viaV1 = await createQuote(app, ctx, { publisher: 'delhi-desk', offer: o.code });
    expect(((viaV1 as { body?: unknown }).body as { reason?: string }).reason).toBe(
      'corridor_unsupported',
    );
    expect(await count('SELECT count(*) AS c FROM quotes')).toBe(before);
    const ok = await app.engine.quote({ offer, actor: A, source: 'direct' });
    if (!ok.ok || ok.value.kind !== 'quote') throw new Error('expected a quote');
    expect(ok.value.price.currency).toBe('EUR');
    expect(ok.value.corridor_id).toBe('in-eur');
    // discovery lists it through the India corridor only
    const inEur = await candidateIds('in-eur');
    const deEur = await candidateIds('de-eur');
    expect(inEur).toContain(o.id);
    expect(deEur).not.toContain(o.id);
  });

  it('the public offer list needs the currency AND the payee country: an India EUR offer is off while only de-eur is on', async () => {
    const o = await made('delhi-desk', 'EUR');
    const listed = async (): Promise<string[]> =>
      (await app.engine.listOffers()).map((x) => x.offer_id);
    expect(await listed()).toContain(o.id);
    await app.db.query("UPDATE corridors SET enabled = false WHERE id = 'in-eur'");
    expect(await listed()).not.toContain(o.id);
  });

  it('with EUR off, EUR offers leave the list, the candidates and the live count; an old receipt still shows', async () => {
    const o = await made('paris-desk', 'EUR');
    const orderId = await pay(A, 'paris-desk', o.code);
    const live = async (): Promise<number> =>
      (await app.engine.publisherHome(pubs['paris-desk']!.actor))!.offers_live;
    const candidates = async (): Promise<string[]> => {
      const ids: string[] = [];
      for (const c of ['us-usd', 'gb-gbp', 'de-eur', 'in-usd', 'in-eur', 'in-gbp'])
        ids.push(...(await candidateIds(c)));
      return ids;
    };
    expect((await app.engine.listOffers()).map((x) => x.offer_id)).toContain(o.id);
    expect(await candidates()).toContain(o.id);
    const liveBefore = await live();
    await app.db.query("UPDATE corridors SET enabled = false WHERE currency = 'EUR'");
    expect((await app.engine.listOffers()).map((x) => x.offer_id)).not.toContain(o.id);
    expect(await candidates()).not.toContain(o.id);
    expect(await live()).toBeLessThan(liveBefore);
    const receipt = await call(receiptsRoute.GET as Handler, {
      url: `/api/receipts/${orderId}`,
      session: SA,
      params: { order: orderId },
    });
    expect(receipt.status).toBe(200);
    expect(await receipt.text()).toContain('EUR');
  });
});
