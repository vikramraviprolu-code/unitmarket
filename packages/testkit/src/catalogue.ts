// Seeded catalogue for tests: the fictional publishers, articles and offers of the catalogue lane.
import { IdSchema } from '@umsbx/contracts';
import type { Database, Id } from '@umsbx/contracts';
import {
  SEED_DATA,
  SEED_SUPPLEMENT_COMPOSITE,
  seedCatalogue,
  seedSupplement,
} from '@umsbx/catalogue';
import { T0, fakeClock, seededIds } from './clock';

/**
 * Seeds the catalogue (idempotent) and returns the ids of authorised offers and of publishers.
 * `{ composite: true }` also applies the MVP-D supplement (Quayside Gazette) under its own seeded
 * Ids, so no id of the base seed moves; without it nothing changes.
 */
export async function seedTestCatalogue(
  db: Database,
  opts: { composite?: boolean } = {},
): Promise<{ offer_ids: Id[]; publisher_ids: Id[] }> {
  await seedCatalogue(db, fakeClock(T0), seededIds('testkit-catalogue'), SEED_DATA);
  if (opts.composite === true) {
    await seedSupplement(
      db,
      fakeClock(T0),
      seededIds('testkit-catalogue-composite'),
      SEED_SUPPLEMENT_COMPOSITE,
    );
  }
  const offers = await db.query<{ id: string }>(
    "SELECT DISTINCT id FROM offers WHERE status = 'authorised' ORDER BY id",
  );
  const publishers = await db.query<{ id: string }>('SELECT id FROM publishers ORDER BY slug');
  return {
    offer_ids: offers.rows.map((r) => IdSchema.parse(r.id)),
    publisher_ids: publishers.rows.map((r) => IdSchema.parse(r.id)),
  };
}
