// PG-2 (PG-1 LOW): the session is set by the URL and the driver alone. PGSSLMODE and PGOPTIONS in the
// environment change nothing, and a COMMIT the server answers with ROLLBACK is an error. Real Postgres
// 16 (UMS_TEST_PG_BIN), unix socket.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './pglite';
import { pgBinConfigured, startTestPostgres } from './pg-testing';
import type { TestPostgres } from './pg-testing';

describe.skipIf(!pgBinConfigured())('PG-2 pg session hygiene (real Postgres)', () => {
  let server: TestPostgres;
  let url: string;
  beforeAll(async () => {
    server = await startTestPostgres();
    url = (await server.createDatabase('pg2_session')).url;
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await server?.stop();
  });

  it('PGSSLMODE=require and PGOPTIONS cannot change the session', async () => {
    vi.stubEnv('PGSSLMODE', 'require'); // a unix socket has no TLS: honouring it would fail the connect
    vi.stubEnv('PGOPTIONS', '-c statement_timeout=1 -c default_transaction_read_only=on');
    const db = await openDatabase({ kind: 'postgres', url, pool_max: 1 });
    try {
      const r = await db.query<{ t: string; ro: string; ssl: boolean }>(
        `SELECT current_setting('statement_timeout') AS t,
                current_setting('default_transaction_read_only') AS ro,
                coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl`,
      );
      expect(r.rows[0]).toEqual({ t: '30s', ro: 'off', ssl: false });
      await db.exec('CREATE TABLE IF NOT EXISTS pg2_writable (n int)'); // writes still work
    } finally {
      vi.unstubAllEnvs();
      await db.close();
    }
  });

  it('a commit that the server turns into a rollback is an error, and nothing is kept', async () => {
    const db = await openDatabase({ kind: 'postgres', url, pool_max: 2 });
    try {
      await db.exec('CREATE TABLE IF NOT EXISTS pg2_commit (n int)');
      await expect(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO pg2_commit VALUES (1)');
          await tx.query('SELECT 1/0').catch(() => undefined); // aborts the transaction; the error is swallowed
          return 'looks fine';
        }),
      ).rejects.toThrow(/rolled back/);
      expect(
        (await db.query<{ c: number }>('SELECT count(*) AS c FROM pg2_commit')).rows[0]?.c,
      ).toBe(0);
      // the pool still works afterwards
      expect((await db.query<{ n: number }>('SELECT 1 AS n')).rows[0]?.n).toBe(1);
    } finally {
      await db.close();
    }
  });
});
