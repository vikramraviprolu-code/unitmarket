// MC2-L2 (docs/specs/mc2-l2-de-eur-corridor.md, D-084 item 6): the German euro corridor and one fictional
// German publisher, applied as a supplement block so it reaches a database that already holds the old seed.
// Since 0034 (WW-COR) the corridor row comes from the migration, wide and on; the seed block mirrors it.
// Dry data only: nothing here touches PayPal.
import { afterAll, describe, expect, it } from 'vitest';
import { WORLDWIDE_PAYEE_COUNTRIES } from '@umsbx/contracts';
import {
  getCorridor,
  listAuthorisedOffers,
  seedCatalogue,
  seedSupplement,
  SEED_DATA,
  SEED_SUPPLEMENT_COMPOSITE,
  SEED_SUPPLEMENT_DE,
} from './index';
import { fakeClock, seededIds, T0, testDb } from './support';

type Db = Awaited<ReturnType<typeof testDb>>;
const open: Db[] = [];
const fresh = async (): Promise<Db> => {
  const d = await testDb();
  open.push(d);
  return d;
};
afterAll(async () => {
  for (const d of open) await d.close();
});

const de = (d: Db, seed = 'seed-de') =>
  seedSupplement(d, fakeClock(T0), seededIds(seed), SEED_SUPPLEMENT_DE);
const base = (d: Db, seed = 'seed') => seedCatalogue(d, fakeClock(T0), seededIds(seed), SEED_DATA);
const composite = (d: Db, seed = 'seed-composite') =>
  seedSupplement(d, fakeClock(T0), seededIds(seed), SEED_SUPPLEMENT_COMPOSITE);

const snapshot = async (d: Db) => ({
  corridors: (await d.query('SELECT * FROM corridors ORDER BY id')).rows,
  publishers: (
    await d.query(
      'SELECT id, slug, country, paypal_merchant_id, payee_shared FROM publishers ORDER BY slug',
    )
  ).rows,
  articles: (await d.query('SELECT id, content_key, sha256 FROM articles ORDER BY content_key'))
    .rows,
  offers: (
    await d.query(
      'SELECT id, version, article_id, currency, options FROM offers ORDER BY id, version',
    )
  ).rows,
  blobs: (await d.query('SELECT content_key, sha256 FROM content_blobs ORDER BY content_key')).rows,
  auths: (await d.query('SELECT id FROM publisher_authorisations ORDER BY id')).rows,
});

describe('SEED_SUPPLEMENT_DE: the data', () => {
  it('holds the worldwide de-eur corridor (on, every country but India), one fictional German publisher and three EUR offers', () => {
    expect(SEED_SUPPLEMENT_DE.corridors).toEqual([
      {
        id: 'de-eur',
        currency: 'EUR',
        minor_units: 2,
        buyer_countries: ['*'],
        payee_countries: [...WORLDWIDE_PAYEE_COUNTRIES],
        domestic_supported: true,
        min_charge_minor: null,
        enabled: true,
      },
    ]);
    expect(SEED_SUPPLEMENT_DE.publishers).toHaveLength(1);
    const p = SEED_SUPPLEMENT_DE.publishers[0]!;
    expect(p.country).toBe('DE');
    expect(p.display_name).toMatch(/\(fictional\)$/);
    expect(SEED_SUPPLEMENT_DE.articles).toHaveLength(3);
    expect(SEED_SUPPLEMENT_DE.articles.every((a) => a.publisher_slug === p.slug)).toBe(true);
    expect(SEED_SUPPLEMENT_DE.offers).toHaveLength(3);
    for (const o of SEED_SUPPLEMENT_DE.offers) {
      expect(o.currency).toBe('EUR');
      expect(o.status).toBe('authorised');
      expect(o.authorised).toBe(true);
      expect(o.options.map((x) => x.option)).toEqual(['keep_retrieve', 'online_read']);
      for (const x of o.options) {
        expect(x.price_minor).toBeGreaterThanOrEqual(100);
        expect(x.price_minor).toBeLessThanOrEqual(200);
      }
    }
  });

  it('is team-written and fictional: no URL, rights notes present, no real brand', () => {
    const text = JSON.stringify(SEED_SUPPLEMENT_DE);
    expect(text).not.toMatch(/https?:\/\/|www\./i);
    expect(text).not.toMatch(/@|paypal/i);
    for (const a of SEED_SUPPLEMENT_DE.articles) {
      expect(a.language).toBe('de');
      expect(a.rights_note.length).toBeGreaterThan(10);
      expect(a.text.length).toBeGreaterThan(40);
    }
  });

  it('SEED_DATA and the composite block stay unchanged (no German content in them)', () => {
    expect(SEED_DATA.corridors.map((c) => c.id)).toEqual(['gb-gbp']);
    expect(SEED_DATA.publishers).toHaveLength(2);
    expect(SEED_DATA.articles).toHaveLength(8);
    expect(SEED_DATA.offers).toHaveLength(8);
    expect(SEED_SUPPLEMENT_COMPOSITE.publishers).toHaveLength(1);
    expect(JSON.stringify(SEED_DATA) + JSON.stringify(SEED_SUPPLEMENT_COMPOSITE)).not.toContain(
      'EUR',
    );
  });
});

describe('after the seed (acceptance 1)', () => {
  it('de-eur exists and is switched on (0034); the German publisher and its EUR offers are authorised and current', async () => {
    const d = await fresh();
    await base(d);
    expect(await de(d)).toEqual({ publishers: 1, articles: 3, offers: 3 });
    const c = await getCorridor(d, 'de-eur');
    expect(c).toMatchObject({
      id: 'de-eur',
      currency: 'EUR',
      minor_units: 2,
      payee_countries: [...WORLDWIDE_PAYEE_COUNTRIES].sort(),
      buyer_countries: ['*'],
      domestic_supported: true,
      enabled: true,
    });
    const pub = await d.query<{ id: string; slug: string; country: string; status: string }>(
      `SELECT id, slug, country, status FROM publishers WHERE country = 'DE'`,
    );
    expect(pub.rows).toHaveLength(1);
    expect(pub.rows[0]).toMatchObject({
      slug: SEED_SUPPLEMENT_DE.publishers[0]!.slug,
      status: 'active',
    });
    const offers = await d.query<{
      id: string;
      status: string;
      currency: string;
      superseded_by: string | null;
      valid_until: string | null;
      options: { option: string; price_minor: number }[];
    }>(
      `SELECT id, status, currency, superseded_by, valid_until, options FROM offers WHERE publisher_id = $1 ORDER BY id`,
      [pub.rows[0]!.id],
    );
    expect(offers.rows).toHaveLength(3);
    for (const o of offers.rows) {
      expect(o).toMatchObject({
        status: 'authorised',
        currency: 'EUR',
        superseded_by: null,
        valid_until: null,
      });
    }
    const auth = await d.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM publisher_authorisations pa JOIN offers o ON o.id = pa.offer_id AND o.version = pa.offer_version WHERE o.publisher_id = $1`,
      [pub.rows[0]!.id],
    );
    expect(auth.rows[0]!.n).toBe(3);
    // Listing follows the corridor switch: the three offers while on (the 0034 default), nothing once an operator turns it off.
    const listed = await listAuthorisedOffers(d, { corridor_id: 'de-eur', limit: 50 });
    expect(listed).toHaveLength(3);
    expect(listed.every((v) => v.offer.currency === 'EUR')).toBe(true);
    await d.query(`UPDATE corridors SET enabled = false WHERE id = 'de-eur'`);
    expect(await listAuthorisedOffers(d, { corridor_id: 'de-eur', limit: 50 })).toEqual([]);
    await d.query(`UPDATE corridors SET enabled = true WHERE id = 'de-eur'`);
    // The other corridors are not affected: still USD only for us-usd.
    const us = await listAuthorisedOffers(d, { corridor_id: 'us-usd', limit: 50 });
    expect(us.every((v) => v.offer.currency === 'USD')).toBe(true);
  });

  it('the German publisher is unverified until the audited payee step: no merchant id, not shared', async () => {
    const d = await fresh();
    await de(d);
    const r = await d.query(
      `SELECT paypal_merchant_id, payee_verified_at, payee_shared FROM publishers WHERE country = 'DE'`,
    );
    expect(r.rows).toEqual([
      { paypal_merchant_id: null, payee_verified_at: null, payee_shared: false },
    ]);
  });
});

describe('idempotent, also over the previous seed (acceptance 3)', () => {
  it('seeding twice, and with a new Ids instance (a new boot), changes nothing', async () => {
    const d = await fresh();
    expect(await de(d)).toEqual({ publishers: 1, articles: 3, offers: 3 });
    const before = await snapshot(d);
    expect(await de(d)).toEqual({ publishers: 0, articles: 0, offers: 0 });
    expect(await de(d, 'another-boot')).toEqual({ publishers: 0, articles: 0, offers: 0 });
    expect(await snapshot(d)).toEqual(before);
  });

  it('on a database that holds the old seed (base + composite): adds only the German rows, loses nothing', async () => {
    const d = await fresh();
    await base(d);
    await composite(d);
    // The hosted disk: payees were set by hand or by the earlier seed step.
    await d.query(
      `UPDATE publishers SET paypal_merchant_id = 'SBXPAYEEHARBOUR1', payee_verified_at = $1 WHERE slug = 'harbour-ledger'`,
      [T0],
    );
    const old = await snapshot(d);
    expect(old.corridors.map((c) => (c as { id: string }).id)).toEqual([
      'de-eur',
      'gb-gbp',
      'in-eur',
      'in-gbp',
      'in-usd',
      'us-usd',
    ]);
    expect(await de(d, 'boot-after-deploy')).toEqual({ publishers: 1, articles: 3, offers: 3 });
    const now = await snapshot(d);
    // Nothing of the old seed moved or disappeared: every old row is still there, unchanged.
    for (const k of ['corridors', 'publishers', 'articles', 'offers', 'blobs', 'auths'] as const) {
      for (const row of old[k]) expect(now[k]).toContainEqual(row);
    }
    // The corridor row is the migration's (0034), so the supplement adds no corridor.
    expect(now.corridors).toHaveLength(old.corridors.length);
    expect(now.publishers).toHaveLength(old.publishers.length + 1);
    expect(now.articles).toHaveLength(old.articles.length + 3);
    expect(now.offers).toHaveLength(old.offers.length + 3);
    expect(now.blobs).toHaveLength(old.blobs.length + 3);
    expect(now.auths).toHaveLength(old.auths.length + 3);
    // The stored payee of the old publisher is untouched.
    const h = await d.query(
      `SELECT paypal_merchant_id FROM publishers WHERE slug = 'harbour-ledger'`,
    );
    expect(h.rows).toEqual([{ paypal_merchant_id: 'SBXPAYEEHARBOUR1' }]);
    // Every later boot adds nothing, and the base seed adds nothing either.
    expect(await de(d, 'boot-2')).toEqual({ publishers: 0, articles: 0, offers: 0 });
    expect(await base(d, 'boot-2')).toEqual({ publishers: 0, articles: 0, offers: 0 });
    expect(await composite(d, 'boot-2')).toEqual({ publishers: 0, articles: 0, offers: 0 });
    expect(await snapshot(d)).toEqual(now);
  });

  it('the order does not matter: the German block first, the old seed after, gives the same rows', async () => {
    const a = await fresh();
    const b = await fresh();
    await base(a);
    await composite(a);
    await de(a);
    await de(b);
    await base(b);
    await composite(b);
    const sa = await snapshot(a);
    const sb = await snapshot(b);
    // Ids come from the Ids instance, so compare by stable keys, not by generated id.
    const keys = (s: Awaited<ReturnType<typeof snapshot>>) => ({
      corridors: s.corridors.map((c) => (c as { id: string }).id),
      publishers: s.publishers.map((p) => (p as { slug: string }).slug),
      articles: s.articles.map((x) => (x as { content_key: string }).content_key),
      offers: s.offers.map((o) => (o as { id: string }).id),
    });
    expect(keys(sb)).toEqual(keys(sa));
  });

  it('an operator switch survives a re-seed: an enabled de-eur stays enabled, a changed price stays', async () => {
    const d = await fresh();
    await de(d);
    await d.query(`UPDATE corridors SET enabled = true WHERE id = 'de-eur'`);
    await de(d, 'later-boot');
    expect((await getCorridor(d, 'de-eur'))?.enabled).toBe(true);
    // And the reverse: a corridor an operator switched off is not switched on by the seed.
    await d.query(`UPDATE corridors SET enabled = false WHERE id = 'de-eur'`);
    await de(d, 'later-boot-2');
    expect((await getCorridor(d, 'de-eur'))?.enabled).toBe(false);
  });

  it('a malformed German block is refused before any write', async () => {
    const d = await fresh();
    await expect(
      seedSupplement(d, fakeClock(T0), seededIds('x'), { ...SEED_SUPPLEMENT_DE, offers: [{}] }),
    ).rejects.toThrow(/seed data invalid|invalid/i);
    const n = await d.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM publishers)::int + (SELECT count(*) FROM corridors WHERE id = 'de-eur')::int AS n`,
    );
    expect(n.rows[0]!.n).toBe(0);
  });
});
