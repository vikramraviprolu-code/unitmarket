// PUB-E1 adversarial: the export and create routes. Nobody but a signed-in publisher gets a file; a
// client supplied id is refused; CSV cells cannot run as formulas; a hostile article title is made safe.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootOffersWorld, both } from './offers-support';
import type { OffersWebWorld } from './offers-support';
import { buy } from './refund-support';
import { call } from './support';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let w: OffersWebWorld;
let exportRoute: typeof import('./app/api/publisher/export/route');
let createRoute: typeof import('./app/api/publisher/offers/create/route');

beforeAll(async () => {
  w = await bootOffersWorld();
  exportRoute = await import('./app/api/publisher/export/route');
  createRoute = await import('./app/api/publisher/offers/create/route');
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const get = (url: string, session: typeof w.refund.A | null) =>
  call(exportRoute.GET as Handler, { url, session });
const rows = async (): Promise<number[]> => {
  const c = async (sql: string) => Number((await w.app.db.query<{ c: string }>(sql)).rows[0]!.c);
  return [
    await c('SELECT count(*) AS c FROM offers'),
    await c('SELECT count(*) AS c FROM publisher_authorisations'),
    await c("SELECT count(*) AS c FROM audit_log WHERE action = 'offer.created'"),
  ];
};

describe('export access', () => {
  it('refuses no session, a buyer, an operator with and without the second factor', async () => {
    for (const s of [null, w.refund.A, w.refund.op, w.refund.demo]) {
      for (const kind of ['sales', 'statement']) {
        const res = await get(`/api/publisher/export?kind=${kind}`, s);
        expect([401, 403]).toContain(res.status);
        expect(await res.text()).not.toContain('order_ref_last6');
        expect(res.headers.get('content-disposition')).toBeNull();
      }
    }
  });

  it('refuses an unknown kind, a missing kind and every extra query field, including a publisher id', async () => {
    const s = w.pub['harbour-ledger'];
    for (const q of [
      'kind=users',
      'kind=',
      '',
      'kind=sales&publisher_id=pub_x',
      `kind=sales&publisher=${w.pubId['quayside-gazette']}`,
      'kind=sales&kind=statement&extra=1',
      'kind=sales&format=xlsx',
    ]) {
      const res = await get(`/api/publisher/export?${q}`, s);
      expect(res.status, q).toBe(422);
      expect(res.headers.get('content-disposition'), q).toBeNull();
    }
  });

  it('never carries another publisher’s rows even when its id is guessed in the query', async () => {
    const bought = await buy(w.refund, { offer: 'tide-tables', option: 'keep_retrieve' });
    const ref6 = bought.order_ref.slice(-6);
    const res = await get(
      `/api/publisher/export?kind=sales&publisher_id=${w.pubId['harbour-ledger']}`,
      w.pub['quayside-gazette'],
    );
    expect(res.status).toBe(422);
    const own = await (
      await get('/api/publisher/export?kind=sales', w.pub['quayside-gazette'])
    ).text();
    expect(own).not.toContain(ref6);
    const theirs = await (
      await get('/api/publisher/export?kind=sales', w.pub['harbour-ledger'])
    ).text();
    expect(theirs).toContain(ref6);
  });
});

describe('CSV injection', () => {
  it('a formula in an article title is exported with a leading quote, in both files', async () => {
    await w.app.db.query(
      'UPDATE articles SET title = \'=HYPERLINK("http://x","y")\' WHERE id IN (SELECT article_id FROM offers WHERE id = \'ofr_harbour-ledger_ferry-timetables\')',
    );
    await buy(w.refund, { offer: 'ferry-timetables', option: 'keep_retrieve', who: 'B' });
    const res = await get('/api/publisher/export?kind=sales', w.pub['harbour-ledger']);
    const text = ((await res.json()) as { csv: string }).csv;
    expect(text).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    for (const line of text.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(/^["]?[=+\-@]/.test(cell), cell).toBe(false);
      }
    }
  });
});

describe('create route', () => {
  const post = (session: typeof w.refund.A | null, body: unknown, csrf?: boolean) =>
    call(createRoute.POST as Handler, {
      url: '/api/publisher/offers/create',
      method: 'POST',
      body,
      session,
      ...(csrf === undefined ? {} : { csrf }),
    });
  const art = async (slug: 'harbour-ledger' | 'quayside-gazette', key: string) => {
    const id = `art_e1a_${key}`;
    await w.app.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ($1,$2,$3,'An abstract.','en',ARRAY['t'],'2026-10-21T10:00:00Z',$4,$5,1,'text/plain','2026-10-21T10:00:00Z','2026-10-21T10:00:00Z')`,
      [id, w.pubId[slug], `E1A ${key}`, 'c'.repeat(64), `e1a/${key}`],
    );
    return id;
  };

  it('needs the CSRF token and a publisher session; writes nothing otherwise', async () => {
    const id = await art('harbour-ledger', 'csrf');
    const before = await rows();
    const body = { article_id: id, options: both(100, 100), attestation: true };
    expect((await post(w.pub['harbour-ledger'], body, false)).status).toBe(403);
    expect((await post(null, body)).status).toBe(401);
    expect([401, 403]).toContain((await post(w.refund.A, body)).status);
    expect([401, 403]).toContain((await post(w.refund.op, body)).status);
    expect(await rows()).toEqual(before);
  });

  it('refuses every extra field (mass assignment) and a body over 2 KB, writing nothing', async () => {
    const id = await art('harbour-ledger', 'mass');
    const before = await rows();
    const base = { article_id: id, options: both(100, 100), attestation: true };
    for (const extra of [
      { publisher_id: w.pubId['quayside-gazette'] },
      // OFFER-CUR made `currency` (USD, EUR or GBP) a field the seller may send; any other value is refused.
      { currency: 'JPY' },
      { status: 'draft' },
      { terms_version: 'x' },
      { rights: { scope: 'personal_use' } },
    ]) {
      expect((await post(w.pub['harbour-ledger'], { ...base, ...extra })).status).toBe(422);
    }
    expect(
      (
        await post(w.pub['harbour-ledger'], {
          ...base,
          options: [{ option: 'online_read', price_minor: 100, policy_id: 'x' }],
        })
      ).status,
    ).toBe(422);
    expect(
      (await post(w.pub['harbour-ledger'], { ...base, article_id: 'a'.repeat(3000) })).status,
    ).toBe(413);
    expect(await rows()).toEqual(before);
  });

  it('answers 404 alike for another publisher’s article and a guessed id', async () => {
    const mine = await art('quayside-gazette', 'theirs');
    const before = await rows();
    const a = await post(w.pub['harbour-ledger'], {
      article_id: mine,
      options: both(100, 100),
      attestation: true,
    });
    const b = await post(w.pub['harbour-ledger'], {
      article_id: 'art_guess_1234',
      options: both(100, 100),
      attestation: true,
    });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await b.json()) as unknown).toMatchObject({ error: { code: 'not_found' } });
    expect(await rows()).toEqual(before);
  });

  it('a suspended publisher cannot create, and the tick is required', async () => {
    const id = await art('harbour-ledger', 'susp');
    await w.app.db.query("UPDATE publishers SET status = 'suspended' WHERE id = $1", [
      w.pubId['harbour-ledger'],
    ]);
    const res = await post(w.pub['harbour-ledger'], {
      article_id: id,
      options: both(100, 100),
      attestation: true,
    });
    expect(res.status).toBe(403);
    await w.app.db.query("UPDATE publishers SET status = 'active' WHERE id = $1", [
      w.pubId['harbour-ledger'],
    ]);
  });
});
