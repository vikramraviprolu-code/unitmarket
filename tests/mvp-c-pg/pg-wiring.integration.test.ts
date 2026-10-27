// PG-2: the app on UMS_DB=postgres. Two apps booting at once on a fresh database both come up (the
// migration lock), and a row another connection inserts is seen by the running app without a restart.
// Runs only when UMS_TEST_PG_BIN is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@umsbx/db';
import { systemClock } from '@umsbx/runtime';
import { readSafetyStatus } from '@umsbx/safety';
import { createApp } from '../../apps/web/composition.server';
import { testEnv } from '../../apps/web/src/support';
import { PG_ON, bootPgRig, startTestPostgres } from './pg-support';
import type { TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

describe.skipIf(!PG_ON)('PG-2 wiring on real Postgres', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  it('two apps booting at the same moment on one fresh database both come up', async () => {
    const c = await server.createDatabase('ums_boot');
    const env = await testEnv({ UMS_DB: 'postgres', DATABASE_URL: c.url });
    const apps = [
      createApp(env, { switch_cache_ms: 0 }),
      createApp(env, { switch_cache_ms: 0 }),
      createApp(env, { switch_cache_ms: 0 }),
    ];
    try {
      await Promise.all(apps.map((a) => a.ready()));
      const counts = await Promise.all(
        apps.map(
          async (a) =>
            (await a.db.query<{ c: string }>('SELECT count(*) AS c FROM publishers')).rows[0]?.c,
        ),
      );
      expect(new Set(counts).size).toBe(1);
      expect(Number(counts[0])).toBeGreaterThan(0);
      expect(apps[0]!.db.dialect).toBe('pg');
    } finally {
      for (const a of apps) await a.close().catch(() => undefined);
      await server.dropDatabase(c.name);
    }
  }, 90_000);

  it("an approval row inserted over another connection is seen by the running app's safety reader without a restart", async () => {
    const pr = await bootPgRig(server);
    const other = await openDatabase({ kind: 'postgres', url: pr.url, pool_max: 1 });
    try {
      const ref = 'DL-2026-10-27-pg2-later';
      const now = systemClock().now();
      expect((await readSafetyStatus(pr.rig.app.db, now, ref)).budget).toBeNull();
      const at = now.toISOString();
      await other.query(
        `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
         VALUES ('oap_pg2_0000000000000001', $1, 'mvp_c_refunds', $2, 2000, 50, '2999-01-01T00:00:00Z', 'pg2-test', $3, $3)`,
        [ref, ['create_order', 'get_order'], at],
      );
      const seen = await readSafetyStatus(pr.rig.app.db, now, ref);
      expect(seen.budget).toMatchObject({ approval_ref: ref, max_calls_per_day: 50 });
    } finally {
      await other.close();
      await pr.close();
    }
  }, 90_000);
});
