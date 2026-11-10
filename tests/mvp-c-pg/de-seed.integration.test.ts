// MC2-L2: the German corridor supplement on real Postgres. A database that already holds the old seed
// (the hosted one) has de-eur (migration 0034), gets the German publisher and three offers once, also when three boots race;
// nothing of the old seed moves. Runs only when UMS_TEST_PG_BIN is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/web/composition.server';
import { testEnv } from '../../apps/web/src/support';
import { PG_ON, startTestPostgres } from './pg-support';
import type { TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

describe.skipIf(!PG_ON)('MC2-L2 German corridor seed on real Postgres', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  it('an old-seed database gets the German rows once, also under three racing boots; re-seeding adds nothing', async () => {
    const c = await server.createDatabase('ums_de');
    const env = await testEnv({ UMS_DB: 'postgres', DATABASE_URL: c.url });
    const q = async (a: ReturnType<typeof createApp>, sql: string): Promise<number> =>
      Number((await a.db.query<{ c: string }>(sql)).rows[0]!.c);
    try {
      // 1. The previous release: base seed and Quayside, no German block.
      const old = createApp(env, { switch_cache_ms: 0, test_seed: { de_corridor: false } });
      await old.ready();
      const before = {
        publishers: await q(old, 'SELECT count(*) AS c FROM publishers'),
        articles: await q(old, 'SELECT count(*) AS c FROM articles'),
        offers: await q(old, 'SELECT count(*) AS c FROM offers'),
        corridors: await q(old, 'SELECT count(*) AS c FROM corridors'),
        ids: (await old.db.query<{ id: string }>('SELECT id FROM offers ORDER BY id')).rows,
      };
      // The row comes from migration 0034 (WW-COR), on, before any seed step.
      expect(
        await q(old, `SELECT count(*) AS c FROM corridors WHERE id = 'de-eur' AND enabled`),
      ).toBe(1);
      await old.close();
      // 2. The new release boots three times at once on that database.
      const apps = [0, 1, 2].map(() =>
        createApp(env, { switch_cache_ms: 0, test_seed: { de_corridor: true } }),
      );
      try {
        await Promise.all(apps.map((a) => a.ready()));
        const a = apps[0]!;
        expect(
          await q(a, `SELECT count(*) AS c FROM corridors WHERE id = 'de-eur' AND enabled`),
        ).toBe(1);
        expect(await q(a, `SELECT count(*) AS c FROM publishers WHERE country = 'DE'`)).toBe(1);
        expect(await q(a, 'SELECT count(*) AS c FROM publishers')).toBe(before.publishers + 1);
        expect(await q(a, 'SELECT count(*) AS c FROM articles')).toBe(before.articles + 3);
        expect(await q(a, 'SELECT count(*) AS c FROM offers')).toBe(before.offers + 3);
        expect(await q(a, 'SELECT count(*) AS c FROM corridors')).toBe(before.corridors);
        expect(
          await q(
            a,
            `SELECT count(*) AS c FROM offers WHERE currency = 'EUR' AND status = 'authorised'`,
          ),
        ).toBe(3);
        const now = (await a.db.query<{ id: string }>('SELECT id FROM offers ORDER BY id')).rows;
        for (const r of before.ids) expect(now).toContainEqual(r);
      } finally {
        for (const a of apps) await a.close().catch(() => undefined);
      }
      // 3. A later boot changes nothing.
      const later = createApp(env, { switch_cache_ms: 0, test_seed: { de_corridor: true } });
      await later.ready();
      expect(await q(later, 'SELECT count(*) AS c FROM offers')).toBe(before.offers + 3);
      expect(await q(later, 'SELECT count(*) AS c FROM publishers')).toBe(before.publishers + 1);
      await later.close();
    } finally {
      await server.dropDatabase(c.name);
    }
  }, 120_000);
});
