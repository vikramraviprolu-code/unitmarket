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
  seedSupplement,
  SEED_DATA,
  SEED_SUPPLEMENT_COMPOSITE,
} from './index';
import { fakeClock, seededIds, T0, testDb } from './support';

const seedJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/catalogue/seed.json', import.meta.url)),
    'utf8',
  ),
);

const compositeJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/catalogue/seed-composite.json', import.meta.url)),
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

  it('getOffer orders versions numerically: v10 is newer than v9 (review 4 L6)', async () => {
    const base = await getOffer(db, {
      publisher_slug: 'harbour-ledger',
      offer_code: 'tide-tables',
    });
    const id = base!.offer.id;
    const copy = async (v: string) =>
      db.query(
        `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
         SELECT id, $2, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, NULL, created_at, updated_at
           FROM offers WHERE id = $1 ORDER BY version LIMIT 1`,
        [id, v],
      );
    await copy('v9');
    await copy('v10');
    try {
      expect((await getOffer(db, { offer_id: id }))?.offer.version).toBe('v10');
    } finally {
      await db.query("DELETE FROM offers WHERE id = $1 AND version IN ('v9', 'v10')", [id]);
    }
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
    // 0034 (WW-COR): buyer_countries is ['*'] on us-usd, so a buyer in DE finds it too (the buyer pays in the offer's currency)
    expect(
      (await corridorFor(db, { currency: 'USD', payee_country: 'US', buyer_country: 'DE' }))?.id,
    ).toBe('us-usd');
    // 0034 (WW-COR): gb-gbp is wide, on, and its buyer_countries is ['*'], so it matches any buyer country
    expect(
      (await corridorFor(db, { currency: 'GBP', payee_country: 'GB', buyer_country: 'JP' }))?.id,
    ).toBe('gb-gbp');
    const gb = await corridorFor(db, { currency: 'GBP', payee_country: 'GB', buyer_country: null });
    expect(gb?.id).toBe('gb-gbp');
    expect(gb?.enabled).toBe(true);
    // a switched-off corridor is returned as it is, so a caller can tell "off" from "none"
    await db.query(`UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'`);
    expect(
      (await corridorFor(db, { currency: 'GBP', payee_country: 'GB', buyer_country: null }))
        ?.enabled,
    ).toBe(false);
    await db.query(`UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'`);
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
    // gb-gbp is on since 0034 (WW-COR) and lists the GBP offers; a corridor switched off lists nothing
    expect(await listAuthorisedOffers(db, { corridor_id: 'gb-gbp', limit: 50 })).toHaveLength(2);
    await db.query(`UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'`);
    expect(await listAuthorisedOffers(db, { corridor_id: 'gb-gbp', limit: 50 })).toEqual([]);
    await db.query(`UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'`);
    expect(await listAuthorisedOffers(db, { corridor_id: 'missing', limit: 50 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// DP-1 (MVP-D): the supplementary composite block. A third publisher must not move any id of the
// base seed, must be safe to apply on every boot, and must reach a database that already holds the
// base seed (the MVP-C persistent disk).
describe('seedSupplement (DP-1, M4)', () => {
  type Db = Awaited<ReturnType<typeof testDb>>;
  async function fresh(): Promise<Db> {
    return testDb();
  }
  const snapshotIds = async (d: Db) => ({
    publishers: (await d.query('SELECT id, slug FROM publishers ORDER BY slug')).rows,
    articles: (await d.query('SELECT id, content_key FROM articles ORDER BY content_key')).rows,
    offers: (await d.query('SELECT id, version, article_id FROM offers ORDER BY id, version')).rows,
  });
  const supplement = (d: Db, seed = 'seed-composite') =>
    seedSupplement(d, fakeClock(T0), seededIds(seed), SEED_SUPPLEMENT_COMPOSITE);

  it('the typed block mirrors fixtures/catalogue/seed-composite.json and holds no URL', () => {
    expect(compositeJson).toEqual(JSON.parse(JSON.stringify(SEED_SUPPLEMENT_COMPOSITE)));
    expect(compositeJson.meta.source).toBe('synthetic');
    expect(JSON.stringify(compositeJson)).not.toMatch(/https?:\/\/|www\./i);
    expect(compositeJson.publishers).toEqual([
      { slug: 'quayside-gazette', display_name: 'Quayside Gazette (fictional)', country: 'US' },
    ]);
    expect(compositeJson.articles).toHaveLength(2);
    for (const a of compositeJson.articles) expect(a.rights_note.length).toBeGreaterThan(10);
    expect(
      compositeJson.offers.map((o: { options: { price_minor: number }[]; currency: string }) => [
        o.currency,
        ...o.options.map((p) => p.price_minor),
      ]),
    ).toEqual([
      ['USD', 150, 120],
      ['USD', 90, 90],
    ]);
    expect(compositeJson.offers.every((o: { status: string }) => o.status === 'authorised')).toBe(
      true,
    );
  });

  it('seedSupplement adds 1 publisher, 2 articles, 2 offers; a second run adds nothing', async () => {
    const d = await fresh();
    try {
      expect(await supplement(d)).toEqual({ publishers: 1, articles: 2, offers: 2 });
      const before = await snapshotIds(d);
      expect(before.publishers).toHaveLength(1);
      expect(await supplement(d)).toEqual({ publishers: 0, articles: 0, offers: 0 });
      // even with a different Ids instance (a new boot): nothing is added, nothing is renamed
      expect(await supplement(d, 'another-boot')).toEqual({
        publishers: 0,
        articles: 0,
        offers: 0,
      });
      expect(await snapshotIds(d)).toEqual(before);
      const auth = await d.query('SELECT count(*)::int AS n FROM publisher_authorisations');
      expect(auth.rows[0]).toEqual({ n: 2 });
      const blobs = await d.query('SELECT count(*)::int AS n FROM content_blobs');
      expect(blobs.rows[0]).toEqual({ n: 2 });
      // The publisher is unverified until an operator or the audited seeding step verifies it.
      const pub = await d.query(
        'SELECT paypal_merchant_id, payee_verified_at, payee_shared FROM publishers',
      );
      expect(pub.rows).toEqual([
        { paypal_merchant_id: null, payee_verified_at: null, payee_shared: false },
      ]);
      const offers = await listAuthorisedOffers(d, { corridor_id: 'us-usd', limit: 50 });
      expect(offers.map((o) => o.offer.options.map((p) => p.price_minor)).sort()).toEqual([
        [150, 120],
        [90, 90],
      ]);
    } finally {
      await d.close();
    }
  });

  it('base seed ids unchanged when the supplement runs after it', async () => {
    const baseOnly = await fresh();
    const after = await fresh();
    const before = await fresh();
    try {
      await seedCatalogue(baseOnly, fakeClock(T0), seededIds('seed'), SEED_DATA);
      await seedCatalogue(after, fakeClock(T0), seededIds('seed'), SEED_DATA);
      await supplement(after);
      // and the other way round: the supplement first, the base second
      await supplement(before);
      await seedCatalogue(before, fakeClock(T0), seededIds('seed'), SEED_DATA);

      const base = await snapshotIds(baseOnly);
      for (const run of [after, before]) {
        const all = await snapshotIds(run);
        expect(all.publishers).toEqual(expect.arrayContaining(base.publishers));
        expect(all.articles).toEqual(expect.arrayContaining(base.articles));
        expect(all.offers).toEqual(expect.arrayContaining(base.offers));
        expect(all.publishers).toHaveLength(base.publishers.length + 1);
        expect(all.articles).toHaveLength(base.articles.length + 2);
        expect(all.offers).toHaveLength(base.offers.length + 2);
      }
    } finally {
      await baseOnly.close();
      await after.close();
      await before.close();
    }
  });

  it('supplement on a database that already holds the base seed (the MVP-C disk case)', async () => {
    const d = await fresh();
    try {
      await seedCatalogue(d, fakeClock(T0), seededIds('seed'), SEED_DATA);
      // The MVP-C disk: harbour-ledger already stores a verified merchant id.
      await d.query(
        `UPDATE publishers SET paypal_merchant_id = 'SBXPAYEEHARBOUR1', payee_verified_at = $1 WHERE slug = 'harbour-ledger'`,
        [T0],
      );
      const base = await snapshotIds(d);
      expect(await supplement(d)).toEqual({ publishers: 1, articles: 2, offers: 2 });
      const all = await snapshotIds(d);
      for (const k of ['publishers', 'articles', 'offers'] as const) {
        for (const row of base[k]) expect(all[k]).toContainEqual(row);
      }
      const harbour = await d.query(
        `SELECT paypal_merchant_id, payee_verified_at IS NOT NULL AS verified FROM publishers WHERE slug = 'harbour-ledger'`,
      );
      expect(harbour.rows).toEqual([{ paypal_merchant_id: 'SBXPAYEEHARBOUR1', verified: true }]);
      // Every boot after that adds nothing.
      expect(await supplement(d)).toEqual({ publishers: 0, articles: 0, offers: 0 });
      // The base seed is untouched too: SEED_DATA still yields 2 publishers, 8 articles, 8 offers.
      expect(await seedCatalogue(d, fakeClock(T0), seededIds('seed-again'), SEED_DATA)).toEqual({
        publishers: 0,
        articles: 0,
        offers: 0,
      });
    } finally {
      await d.close();
    }
  });

  it('SEED_DATA itself is unchanged: 2 publishers, 8 articles, 8 offers, no Quayside', () => {
    expect(SEED_DATA.publishers.map((p) => p.slug)).toEqual([
      'harbour-ledger',
      'northfield-quarterly',
    ]);
    expect(SEED_DATA.articles).toHaveLength(8);
    expect(SEED_DATA.offers).toHaveLength(8);
    expect(JSON.stringify(SEED_DATA)).not.toContain('quayside');
  });

  it('a malformed block is refused before any write', async () => {
    const d = await fresh();
    try {
      await expect(
        seedSupplement(d, fakeClock(T0), seededIds('x'), { ...compositeJson, offers: [{}] }),
      ).rejects.toThrow(/seed data invalid|invalid/i);
      const n = await d.query('SELECT count(*)::int AS n FROM publishers');
      expect(n.rows[0]).toEqual({ n: 0 });
    } finally {
      await d.close();
    }
  });
});
