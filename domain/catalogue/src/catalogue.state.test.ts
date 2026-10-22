import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  corridorFor,
  getCorridor,
  getOffer,
  listAuthorisedOffers,
  seedCatalogue,
  SEED_DATA,
} from './index';
import { fakeClock, seededIds, T0, testDb } from './support';

const seedJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/catalogue/seed.json', import.meta.url)),
    'utf8',
  ),
);

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.close();
});

describe('seed fixture (PAY-01)', () => {
  it('seed loads 2 publishers, 8 articles, rights notes present, no URL to paywalled text', async () => {
    // fixtures/catalogue/seed.json mirrors the typed seed data
    expect(seedJson).toEqual(JSON.parse(JSON.stringify(SEED_DATA)));
    expect(seedJson.meta.source).toBe('synthetic');
    const counts = await seedCatalogue(db, fakeClock(T0), seededIds('seed'), seedJson);
    expect(counts).toEqual({ publishers: 2, articles: 8, offers: 8 });
    const pubs = await db.query('SELECT count(*)::int AS n FROM publishers');
    const arts = await db.query('SELECT count(*)::int AS n FROM articles');
    const blobs = await db.query('SELECT count(*)::int AS n FROM content_blobs');
    expect(pubs.rows[0]).toEqual({ n: 2 });
    expect(arts.rows[0]).toEqual({ n: 8 });
    expect(blobs.rows[0]).toEqual({ n: 8 });
    for (const a of seedJson.articles) {
      expect(typeof a.rights_note).toBe('string');
      expect(a.rights_note.length).toBeGreaterThan(10);
    }
    expect(JSON.stringify(seedJson)).not.toMatch(/https?:\/\/|www\./i);
    // stored hash is the sha256 of the stored text
    const { rows } = await db.query<{ sha256: string; data: Uint8Array }>(
      'SELECT a.sha256, b.data FROM articles a JOIN content_blobs b USING (content_key)',
    );
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(createHash('sha256').update(r.data).digest('hex')).toBe(r.sha256);
    }
  });

  it('seeding twice is refused or idempotent, never duplicates', async () => {
    await seedCatalogue(db, fakeClock(T0), seededIds('seed2'), seedJson).catch(() => undefined);
    const pubs = await db.query('SELECT count(*)::int AS n FROM publishers');
    expect(pubs.rows[0]).toEqual({ n: 2 });
  });

  it('prices: one 0.40 USD offer, one renegotiable offer with floor 2.00, one withdrawn, one GBP', () => {
    const o = SEED_DATA.offers;
    expect(o.some((x) => x.currency === 'USD' && x.options.some((p) => p.price_minor === 40))).toBe(
      true,
    );
    expect(
      o.some((x) => x.affordability.renegotiation_allowed && x.affordability.floor_minor === 200),
    ).toBe(true);
    expect(o.some((x) => x.status === 'withdrawn')).toBe(true);
    expect(o.some((x) => x.currency === 'GBP')).toBe(true);
    // no universal floor: nothing below 1.00 is rewritten
    expect(Math.min(...o.flatMap((x) => x.options.map((p) => p.price_minor)))).toBe(40);
  });
});

describe('catalogue reads', () => {
  it('getOffer by slug and code returns offer, article and publisher', async () => {
    const r = await getOffer(db, { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' });
    expect(r?.offer.status).toBe('authorised');
    expect(r?.offer.options.map((o) => o.price_minor)).toEqual([40, 40]);
    expect(r?.article.title).toBe('Reading a tide table in ten minutes');
    expect(r?.publisher.slug).toBe('harbour-ledger');
    const byId = await getOffer(db, { offer_id: r!.offer.id });
    expect(byId?.offer).toEqual(r!.offer);
  });

  it('getOffer returns null for unknown, wrong publisher, or odd input', async () => {
    expect(await getOffer(db, { publisher_slug: 'harbour-ledger', offer_code: 'nope' })).toBeNull();
    expect(
      await getOffer(db, { publisher_slug: 'northfield-quarterly', offer_code: 'tide-tables' }),
    ).toBeNull();
    expect(await getOffer(db, { offer_id: 'ofr_missing' })).toBeNull();
    expect(
      await getOffer(db, { publisher_slug: "x' OR '1'='1", offer_code: 'tide-tables' }),
    ).toBeNull();
  });

  it('getCorridor and corridorFor', async () => {
    expect((await getCorridor(db, 'us-usd'))?.enabled).toBe(true);
    expect(await getCorridor(db, 'missing')).toBeNull();
    expect(
      (await corridorFor(db, { currency: 'USD', payee_country: 'US', buyer_country: 'US' }))?.id,
    ).toBe('us-usd');
    expect(
      (await corridorFor(db, { currency: 'USD', payee_country: 'US', buyer_country: null }))?.id,
    ).toBe('us-usd');
    expect(
      await corridorFor(db, { currency: 'USD', payee_country: 'US', buyer_country: 'DE' }),
    ).toBeNull();
    const gb = await corridorFor(db, { currency: 'GBP', payee_country: 'GB', buyer_country: null });
    expect(gb?.id).toBe('gb-gbp');
    expect(gb?.enabled).toBe(false);
  });

  it('listAuthorisedOffers lists only authorised, current offers of the corridor currency and payee country', async () => {
    const rows = await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 50 });
    const codes = rows.map((r) => r.offer.id).sort();
    expect(rows).toHaveLength(4); // withdrawn and draft offers are not listed
    expect(rows.every((r) => r.offer.status === 'authorised' && r.offer.currency === 'USD')).toBe(
      true,
    );
    expect(codes).toHaveLength(4);
    expect(await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 2 })).toHaveLength(2);
    // a disabled corridor lists nothing
    expect(await listAuthorisedOffers(db, { corridor_id: 'gb-gbp', limit: 50 })).toEqual([]);
    expect(await listAuthorisedOffers(db, { corridor_id: 'missing', limit: 50 })).toEqual([]);
  });
});
