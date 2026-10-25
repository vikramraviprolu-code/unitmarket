// DP-1 (MVP-D): seedTestCatalogue(db, { composite: true }) adds the Quayside supplement under its
// own seeded Ids; without the option nothing changes (offer-entry, discovery and mvp-a rely on it).
import { afterEach, describe, expect, it } from 'vitest';
import { seedTestCatalogue, testDb } from './index';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
async function fresh() {
  const db = await testDb();
  closers.push(() => db.close());
  return db;
}
const rows = async (db: Awaited<ReturnType<typeof fresh>>) => ({
  publishers: (await db.query('SELECT id, slug FROM publishers ORDER BY slug')).rows,
  articles: (await db.query('SELECT id, content_key FROM articles ORDER BY content_key')).rows,
  offers: (await db.query('SELECT id, version FROM offers ORDER BY id, version')).rows,
});

describe('seedTestCatalogue composite option (DP-1)', () => {
  it('without the option: 2 publishers, 8 offers rows, no Quayside (unchanged)', async () => {
    const db = await fresh();
    const a = await seedTestCatalogue(db);
    const b = await seedTestCatalogue(db, {});
    const c = await seedTestCatalogue(db, { composite: false });
    expect(a.publisher_ids).toHaveLength(2);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect((await rows(db)).publishers.map((p) => p.slug)).toEqual([
      'harbour-ledger',
      'northfield-quarterly',
    ]);
  });

  it('with { composite: true }: Quayside and its two offers are added, nothing else moves', async () => {
    const plain = await fresh();
    const comp = await fresh();
    const p = await seedTestCatalogue(plain);
    const c = await seedTestCatalogue(comp, { composite: true });
    const before = await rows(plain);
    const after = await rows(comp);
    expect(after.publishers.map((x) => x.slug)).toEqual([
      'harbour-ledger',
      'northfield-quarterly',
      'quayside-gazette',
    ]);
    expect(after.publishers).toEqual(expect.arrayContaining(before.publishers));
    expect(after.articles).toEqual(expect.arrayContaining(before.articles));
    expect(after.offers).toEqual(expect.arrayContaining(before.offers));
    expect(after.articles).toHaveLength(before.articles.length + 2);
    expect(after.offers).toHaveLength(before.offers.length + 2);
    expect(c.publisher_ids).toHaveLength(3);
    expect(c.offer_ids).toHaveLength(p.offer_ids.length + 2);
    expect(c.offer_ids).toEqual(expect.arrayContaining(p.offer_ids));
    expect(c.offer_ids).toContain('ofr_quayside-gazette_market-hall-move');
    expect(c.offer_ids).toContain('ofr_quayside-gazette_quay-walk');
  });

  it('is idempotent and deterministic: the same ids on every run and every database', async () => {
    const one = await fresh();
    const two = await fresh();
    await seedTestCatalogue(one, { composite: true });
    await seedTestCatalogue(one, { composite: true });
    await seedTestCatalogue(two, { composite: true });
    expect(await rows(one)).toEqual(await rows(two));
  });

  it('can be added after a plain seed (the existing-database case)', async () => {
    const db = await fresh();
    await seedTestCatalogue(db);
    const before = await rows(db);
    const r = await seedTestCatalogue(db, { composite: true });
    expect(r.publisher_ids).toHaveLength(3);
    expect((await rows(db)).publishers).toEqual(expect.arrayContaining(before.publishers));
  });
});
