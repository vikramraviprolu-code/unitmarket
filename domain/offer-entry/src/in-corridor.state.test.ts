// COR-IN (docs/specs/db-in-usd-corridor.md): an India publisher's offer is sold in USD to buyers outside India only.
// "Outside India only" is the corridor's domestic_supported = false: a buyer whose country equals the publisher's
// is refused as corridor_unsupported. The corridor itself comes from migration 0033; this test rewrites nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CoreDeps } from '@umsbx/contracts';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { SEED_DATA, seedCatalogue } from '@umsbx/catalogue';
import { startFromOffer } from './index';
import { T0, addBuyer, type TestDb } from './support';

// The seed holds an India publisher and its offer but NO India corridor: the corridor must come from the migration.
const IN_PUBLISHER_SEED = {
  ...SEED_DATA,
  publishers: [
    ...SEED_DATA.publishers,
    { slug: 'delhi-desk', display_name: 'Delhi Desk (fictional)', country: 'IN' },
  ],
  articles: [
    ...SEED_DATA.articles,
    {
      key: 'monsoon-notes',
      publisher_slug: 'delhi-desk',
      title: 'Monsoon notes for a city commuter',
      abstract: 'A fictional note on planning a commute in the wet season.',
      language: 'en',
      topics: ['transport'],
      published_at: '2025-12-15T09:00:00.000Z',
      text: 'Leave twenty minutes earlier and carry a dry bag.\n',
      rights_note: 'Written by the SBX team for the sandbox.',
    },
  ],
  offers: [
    ...SEED_DATA.offers,
    { ...SEED_DATA.offers[0]!, code: 'monsoon-notes', article_key: 'monsoon-notes' },
  ],
};

let db: TestDb;
let deps: CoreDeps;
beforeAll(async () => {
  db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(T0);
  await migrate(db, clock);
  const ids = seededIds('in-corridor');
  await seedCatalogue(db, clock, ids, IN_PUBLISHER_SEED);
  deps = { db, clock, ids } as unknown as CoreDeps;
});
afterAll(async () => {
  await db.close();
});

const offer = { publisher_slug: 'delhi-desk', offer_code: 'monsoon-notes' };
const buyer = async (country: string): Promise<Actor> => ({
  kind: 'buyer',
  buyer_id: await addBuyer(db, country),
});

describe('an India publisher in the in-usd corridor', () => {
  it('the corridor row is the migration row: any buyer country, no domestic sale, on', async () => {
    const r = await db.query(
      `SELECT buyer_countries, payee_countries, domestic_supported, enabled FROM corridors WHERE id = 'in-usd'`,
    );
    expect(r.rows).toEqual([
      {
        buyer_countries: ['*'],
        payee_countries: ['IN'],
        domestic_supported: false,
        enabled: true,
      },
    ]);
  });

  it.each(['US', 'GB', 'DE'])(
    'a buyer in %s may start and is quoted in USD in in-usd',
    async (c) => {
      const r = await startFromOffer(deps, { offer, actor: await buyer(c), source: 'direct' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.value.kind !== 'quote') throw new Error('expected a quote');
      expect(r.value.corridor_id).toBe('in-usd');
      expect(r.value.price.currency).toBe('USD');
    },
  );

  it('an anonymous visitor (no country known) may start', async () => {
    const r = await startFromOffer(deps, { offer, actor: null, source: 'direct' });
    expect(r.ok && r.value.kind === 'quote' && r.value.corridor_id).toBe('in-usd');
  });

  it('a buyer in India is refused: corridor_unsupported, and no quote is stored', async () => {
    const actor = await buyer('IN');
    const before = Number(
      (await db.query<{ c: string }>('SELECT count(*) AS c FROM quotes')).rows[0]!.c,
    );
    const r = await startFromOffer(deps, { offer, actor, source: 'direct' });
    expect(r.ok && r.value).toEqual({ kind: 'no_match', reason: 'corridor_unsupported' });
    const after = Number(
      (await db.query<{ c: string }>('SELECT count(*) AS c FROM quotes')).rows[0]!.c,
    );
    expect(after).toBe(before);
  });

  it('the US corridor is not changed: a buyer in India may still buy a US publisher offer', async () => {
    const r = await startFromOffer(deps, {
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
      actor: await buyer('IN'),
      source: 'direct',
    });
    expect(r.ok && r.value.kind === 'quote' && r.value.corridor_id).toBe('us-usd');
  });
});
