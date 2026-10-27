// PG-1: one Database-port contract suite, run against PGlite and (when the server 16 binaries are
// present, UMS_TEST_PG_BIN or /usr/lib/postgresql/16/bin) against a throwaway real Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase, listMigrations, MIGRATIONS_ROOT } from './index';
import type { SqlDriver } from './index';
import { resetDatabase } from './testing';
import { join } from 'node:path';
import { pgAvailable, startTestPostgres } from './pg-testing';
import type { TestPostgres } from './pg-testing';

const clock = { now: () => new Date('2026-10-21T10:00:00Z') };
const T = '2026-10-21T10:00:00Z';

let server: TestPostgres | undefined;
const hasPg = pgAvailable();
beforeAll(async () => {
  if (hasPg) server = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await server?.stop();
}, 60_000);

interface Handle {
  db: SqlDriver;
  dbName: string | null;
  url: string | null;
}
const opened: SqlDriver[] = [];
afterAll(async () => {
  for (const d of opened) await d.close().catch(() => undefined);
});

const targets = [
  {
    name: 'pglite' as const,
    enabled: true,
    open: async (): Promise<Handle> => {
      const db = await openDatabase({ kind: 'pglite-memory' });
      opened.push(db);
      return { db, dbName: null, url: null };
    },
  },
  {
    name: 'postgres' as const,
    enabled: hasPg,
    open: async (opts: { pool_max?: number } = {}): Promise<Handle> => {
      const created = await server!.createDatabase();
      const db = await openDatabase({ kind: 'postgres', url: created.url, ...opts });
      opened.push(db);
      return { db, dbName: created.name, url: created.url };
    },
  },
];

const pubSql = (n: number, shared: boolean, merchant = 'SBXPAYEE1') =>
  `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at, payee_shared)
   VALUES ('pub_c${n}', 'c${n}', 'Pub ${n}', 'US', '${merchant}', '${T}', '${T}', '${T}', ${shared})`;
const codeOf = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => (e as { code?: unknown }).code ?? 'no-code',
  );

describe.each(targets)('Database port contract on $name', (t) => {
  const run = t.enabled ? describe : describe.skip;
  run('port', () => {
    it('reports its dialect and target', async () => {
      const { db } = await t.open();
      expect(db.dialect).toBe(t.name === 'pglite' ? 'pglite' : 'pg');
      expect(db.target).toBe(t.name === 'pglite' ? 'pglite-memory' : 'postgres');
    });

    it('query returns rows, exec runs a multi-statement string', async () => {
      const { db } = await t.open();
      await db.exec(
        'CREATE TABLE c1 (id int PRIMARY KEY, v text); INSERT INTO c1 VALUES (1, $$a$$)',
      );
      const r = await db.query<{ id: number; v: string }>(
        'SELECT id, v FROM c1 WHERE id = $1',
        [1],
      );
      expect(r.rows).toEqual([{ id: 1, v: 'a' }]);
    });

    it('bigint values come back as numbers when safe (PGlite parity)', async () => {
      const { db } = await t.open();
      const r = await db.query<{ n: unknown; ts: unknown; j: unknown }>(
        `SELECT count(*)::bigint AS n, '2026-10-21T10:00:00Z'::timestamptz AS ts, '{"a":1}'::jsonb AS j`,
      );
      expect(r.rows[0]!.n).toBe(1);
      expect(Object.prototype.toString.call(r.rows[0]!.ts)).toBe('[object Date]');
      expect((r.rows[0]!.ts as Date).toISOString()).toBe('2026-10-21T10:00:00.000Z');
      expect(r.rows[0]!.j).toEqual({ a: 1 });
    });

    it('transaction commits and returns the function value', async () => {
      const { db } = await t.open();
      await db.exec('CREATE TABLE c2 (id int PRIMARY KEY)');
      const out = await db.transaction(async (tx) => {
        await tx.query('INSERT INTO c2 VALUES ($1)', [1]);
        return 'done';
      });
      expect(out).toBe('done');
      expect((await db.query('SELECT id FROM c2')).rows).toEqual([{ id: 1 }]);
    });

    it('transaction rolls back and rethrows the same error when the function throws', async () => {
      const { db } = await t.open();
      await db.exec('CREATE TABLE c3 (id int PRIMARY KEY)');
      const boom = new Error('boom');
      await expect(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO c3 VALUES (1)');
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect((await db.query('SELECT id FROM c3')).rows).toEqual([]);
    });

    it('a failed statement inside a transaction rolls the whole transaction back', async () => {
      const { db } = await t.open();
      await db.exec('CREATE TABLE c4 (id int PRIMARY KEY)');
      const code = await codeOf(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO c4 VALUES (1)');
          await tx.query('INSERT INTO c4 VALUES (1)');
        }),
      );
      expect(code).toBe('23505');
      expect((await db.query('SELECT id FROM c4')).rows).toEqual([]);
      // the database still works afterwards
      await db.query('INSERT INTO c4 VALUES (2)');
    });

    it('SET LOCAL is visible only inside the transaction', async () => {
      const { db } = await t.open();
      const inside = await db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ums.probe', 'on', true)");
        return (
          await tx.query<{ v: string | null }>("SELECT current_setting('ums.probe', true) AS v")
        ).rows[0]!.v;
      });
      expect(inside).toBe('on');
      const after = (
        await db.query<{ v: string | null }>("SELECT current_setting('ums.probe', true) AS v")
      ).rows[0]!.v;
      expect(after === null || after === '').toBe(true);
    });

    it('serial transactions on one table do not interleave their rows', async () => {
      const { db } = await t.open();
      await db.exec('CREATE TABLE c5 (n int)');
      await Promise.all(
        [1, 2, 3, 4].map((i) =>
          db.transaction(async (tx) => {
            await tx.query('INSERT INTO c5 VALUES ($1)', [i]);
          }),
        ),
      );
      expect(
        (await db.query<{ n: number }>('SELECT n FROM c5 ORDER BY n')).rows.map((r) => r.n),
      ).toEqual([1, 2, 3, 4]);
    });

    it('migrate() twice leaves one schema_migrations row per version', async () => {
      const { db } = await t.open();
      const first = await migrate(db, clock);
      const files = listMigrations(join(MIGRATIONS_ROOT, 'common')).map((m) => m.version);
      expect(first).toEqual(files);
      expect(await migrate(db, clock)).toEqual([]);
      const rows = await db.query<{ version: string; n: number }>(
        'SELECT version, count(*)::int AS n FROM schema_migrations GROUP BY version ORDER BY version',
      );
      expect(rows.rows.map((r) => r.version)).toEqual(files);
      expect(rows.rows.every((r) => r.n === 1)).toBe(true);
    });

    it('the seed rows from the migrations are there', async () => {
      const { db } = await t.open();
      await migrate(db, clock);
      const sw = await db.query<{ name: string; on: boolean }>(
        'SELECT name, "on" FROM safety_switches ORDER BY name',
      );
      expect(sw.rows).toHaveLength(6);
      expect(sw.rows.find((r) => r.name === 'paypal_outbound')!.on).toBe(false);
    });

    describe('DP-1 ums_publisher_payee_guard (migration 0010)', () => {
      const migrated = async (): Promise<Database> => {
        const { db } = await t.open();
        await migrate(db, clock);
        return db;
      };

      it('refuses a REPEATABLE READ writer of a merchant id with 40001', async () => {
        const db = await migrated();
        const code = await codeOf(
          db.transaction(async (tx) => {
            await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await tx.exec(pubSql(1, true));
          }),
        );
        expect(code).toBe('40001');
        expect((await db.query('SELECT id FROM publishers')).rows).toEqual([]);
      });

      it('accepts READ COMMITTED and SERIALIZABLE writers', async () => {
        const db = await migrated();
        await db.transaction(async (tx) => {
          await tx.exec(pubSql(1, true));
        });
        await db.transaction(async (tx) => {
          await tx.exec('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          await tx.exec(pubSql(2, true));
        });
        expect((await db.query('SELECT id FROM publishers')).rows).toHaveLength(2);
      });

      it('payee-shared rule: both flagged may share, otherwise 23505', async () => {
        const db = await migrated();
        await db.exec(pubSql(1, true));
        await db.exec(pubSql(2, true));
        expect(await codeOf(db.exec(pubSql(3, false)))).toBe('23505');
        await db.exec(pubSql(4, false, 'SBXOTHER'));
        expect(await codeOf(db.exec(pubSql(5, true, 'SBXOTHER')))).toBe('23505');
        expect(await codeOf(db.exec(pubSql(6, false, 'SBXOTHER')))).toBe('23505');
      });
    });

    describe('resetDatabase', () => {
      it('empties application tables and keeps schema_migrations', async () => {
        const { db } = await t.open();
        await migrate(db, clock);
        await db.exec(pubSql(1, false));
        await resetDatabase(db, t.name === 'postgres' ? { confirm: 'RESET_TEST_DATABASE' } : {});
        expect((await db.query('SELECT id FROM publishers')).rows).toEqual([]);
        expect(
          (await db.query('SELECT version FROM schema_migrations')).rows.length,
        ).toBeGreaterThan(0);
      });
    });

    it('later calls reject after close() (a second close() is safe on postgres only)', async () => {
      const { db } = await t.open();
      await db.close();
      // PGlite's own close() throws the second time; its behaviour is not changed by PG-1.
      if (t.name === 'postgres') await db.close();
      await expect(db.query('SELECT 1')).rejects.toThrow();
    });
  });
});

describe.skipIf(!hasPg)('Postgres adapter (real server only)', () => {
  const open = async (opts: Record<string, unknown> = {}) => {
    const created = await server!.createDatabase();
    const db = await openDatabase({ kind: 'postgres', url: created.url, ...opts });
    opened.push(db);
    return { db, ...created };
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('runs SET LOCAL ums.* only inside a transaction and never sets ums.db_target by itself', async () => {
    const { db } = await open();
    await migrate(db, clock);
    const v = await db.query<{ v: string | null }>(
      "SELECT current_setting('ums.db_target', true) AS v",
    );
    expect(v.rows[0]!.v === null || v.rows[0]!.v === '').toBe(true);
    // The TRUNCATE guard of migration 0001 refuses without the reset settings.
    await expect(db.exec('TRUNCATE buyers CASCADE')).rejects.toThrow(/append-only|not allowed/);
  });

  it('resetDatabase refuses without the confirm flag and on a database not named ums_test_', async () => {
    const { db, name } = await open();
    await migrate(db, clock);
    await expect(resetDatabase(db)).rejects.toThrow(/refused/);
    expect(name.startsWith('ums_test_')).toBe(true);
    // a database whose name does not start with ums_test_
    const other = await server!.createDatabase('notatest');
    const odb = await openDatabase({ kind: 'postgres', url: other.url });
    opened.push(odb);
    await migrate(odb, clock);
    await expect(resetDatabase(odb, { confirm: 'RESET_TEST_DATABASE' })).rejects.toThrow(/refused/);
    await server!.dropDatabase(other.name).catch(() => undefined);
  });

  it('forced 40001: two parallel REPEATABLE READ updaters, the loser is retried to success', async () => {
    const { db } = await open();
    await db.exec('CREATE TABLE r1 (id int PRIMARY KEY, v int); INSERT INTO r1 VALUES (1, 0)');
    let attempts = 0;
    let reads = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const worker = () =>
      db.transaction(async (tx) => {
        attempts += 1;
        const first = attempts <= 2;
        await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await tx.query('SELECT v FROM r1 WHERE id = 1');
        if (first) {
          reads += 1;
          if (reads === 2) release();
          await both;
        }
        await tx.query('UPDATE r1 SET v = v + 1 WHERE id = 1');
      });
    await Promise.all([worker(), worker()]);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect((await db.query<{ v: number }>('SELECT v FROM r1')).rows[0]!.v).toBe(2);
  });

  it('forced 40P01: a real deadlock is retried to success', async () => {
    const { db } = await open();
    await db.exec(
      'CREATE TABLE d1 (id int PRIMARY KEY, v int); INSERT INTO d1 VALUES (1, 0), (2, 0)',
    );
    let attempts = 0;
    let locked = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const worker = (a: number, b: number) =>
      db.transaction(async (tx) => {
        attempts += 1;
        const first = attempts <= 2;
        await tx.query('UPDATE d1 SET v = v + 1 WHERE id = $1', [a]);
        if (first) {
          locked += 1;
          if (locked === 2) release();
          await both;
        }
        await tx.query('UPDATE d1 SET v = v + 1 WHERE id = $1', [b]);
      });
    await Promise.all([worker(1, 2), worker(2, 1)]);
    expect(attempts).toBeGreaterThanOrEqual(3);
    const r = await db.query<{ v: number }>('SELECT v FROM d1 ORDER BY id');
    expect(r.rows.map((x) => x.v)).toEqual([2, 2]);
  }, 30_000);

  it('a transaction-level advisory lock gives mutual exclusion between two transactions', async () => {
    const { db } = await open();
    const events: string[] = [];
    const hold = (tag: string) =>
      db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(4242)');
        events.push(`${tag}:in`);
        await sleep(150);
        events.push(`${tag}:out`);
      });
    await Promise.all([hold('a'), hold('b')]);
    expect(events).toHaveLength(4);
    expect(events[0]!.endsWith(':in')).toBe(true);
    expect(events[1]).toBe(events[0]!.replace(':in', ':out'));
  });

  it('withAdvisoryLock: mutual exclusion, released after a throw, released by close()', async () => {
    const { db } = await open();
    const lock = db.withAdvisoryLock!;
    const events: string[] = [];
    const hold = (tag: string) =>
      lock('ums.test.lock', async () => {
        events.push(`${tag}:in`);
        await sleep(150);
        events.push(`${tag}:out`);
      });
    await Promise.all([hold('a'), hold('b')]);
    expect(events[1]).toBe(events[0]!.replace(':in', ':out'));
    await expect(
      lock('ums.test.lock', async () => {
        throw new Error('inside');
      }),
    ).rejects.toThrow('inside');
    // free again after the throw
    expect(await lock('ums.test.lock', async () => 'ok')).toBe('ok');
  });

  it('two concurrent migrate() calls on separate pools apply each version once and raise nothing', async () => {
    const created = await server!.createDatabase();
    const a = await openDatabase({ kind: 'postgres', url: created.url });
    const b = await openDatabase({ kind: 'postgres', url: created.url });
    opened.push(a, b);
    const [ra, rb] = await Promise.all([migrate(a, clock), migrate(b, clock)]);
    const files = listMigrations(join(MIGRATIONS_ROOT, 'common')).map((m) => m.version);
    expect([...ra, ...rb].sort()).toEqual(files);
    const rows = await a.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.rows.map((r) => r.version)).toEqual(files);
  });

  it('three concurrent migrate() calls on one pool also apply each version once', async () => {
    const { db } = await open();
    const rs = await Promise.all([migrate(db, clock), migrate(db, clock), migrate(db, clock)]);
    const files = listMigrations(join(MIGRATIONS_ROOT, 'common')).map((m) => m.version);
    expect(rs.flat().sort()).toEqual(files);
  });

  it('migrate() waits while another session holds the migration lock', async () => {
    const { db } = await open();
    const { MIGRATE_LOCK_KEY } = await import('./migrate');
    let finished = false;
    let started!: Promise<string[]>;
    await db.withAdvisoryLock!(MIGRATE_LOCK_KEY, async () => {
      started = migrate(db, clock).then((r) => {
        finished = true;
        return r;
      });
      await sleep(400);
      expect(finished).toBe(false);
      const t0 = await db.query("SELECT to_regclass('schema_migrations') AS t");
      expect((t0.rows[0] as { t: unknown }).t).toBeNull();
    });
    const applied = await started;
    expect(applied.length).toBeGreaterThan(0);
  });

  it('pool_max bounds the number of server connections', async () => {
    const { db } = await open({ pool_max: 2 });
    const pids = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.query<{ pid: number }>('SELECT pg_sleep(0.15), pg_backend_pid() AS pid'),
      ),
    );
    expect(new Set(pids.map((p) => p.rows[0]!.pid)).size).toBeLessThanOrEqual(2);
  });

  it('sets application_name umsbx and the default timeouts', async () => {
    const { db } = await open();
    const r = await db.query<{ a: string; s: string }>(
      "SELECT current_setting('application_name') AS a, current_setting('statement_timeout') AS s",
    );
    expect(r.rows[0]).toEqual({ a: 'umsbx', s: '30s' });
  });

  it('statement_timeout_ms is applied (57014 query_canceled)', async () => {
    const { db } = await open({ statement_timeout_ms: 250 });
    expect(await codeOf(db.query('SELECT pg_sleep(2)'))).toBe('57014');
    // the pool still works
    expect((await db.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  });

  it('a throwing transaction leaves no idle-in-transaction session and no leaked client', async () => {
    const { db, name } = await open({ pool_max: 2 });
    for (let i = 0; i < 12; i += 1) {
      await db
        .transaction(async () => {
          throw new Error('x');
        })
        .catch(() => undefined);
    }
    // pool of 2 still serves 12 more transactions
    for (let i = 0; i < 12; i += 1)
      await db.transaction(async (tx) => void (await tx.query('SELECT 1')));
    const admin = await openDatabase({ kind: 'postgres', url: server!.urlFor('postgres') });
    opened.push(admin);
    const r = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND state LIKE 'idle in transaction%'",
      [name],
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  it('the transaction executor refuses use after the transaction ended', async () => {
    const { db } = await open();
    let saved: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
    await db.transaction(async (tx) => {
      saved = tx;
    });
    await expect(saved!.query('SELECT 1')).rejects.toThrow(/transaction/);
  });

  it('close() ends every server connection of the pool', async () => {
    const created = await server!.createDatabase();
    const db = await openDatabase({ kind: 'postgres', url: created.url, pool_max: 3 });
    await Promise.all([1, 2, 3].map(() => db.query('SELECT pg_sleep(0.05)')));
    await db.close();
    const admin = await openDatabase({ kind: 'postgres', url: server!.urlFor('postgres') });
    opened.push(admin);
    let n = -1;
    for (let i = 0; i < 20 && n !== 0; i += 1) {
      n = (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
          [created.name],
        )
      ).rows[0]!.n;
      if (n !== 0) await sleep(100);
    }
    expect(n).toBe(0);
    await expect(db.transaction(async () => 1)).rejects.toThrow();
  });

  it('SQL error codes and constraint names pass through unchanged', async () => {
    const { db } = await open();
    await db.exec('CREATE TABLE e1 (id int CONSTRAINT e1_pk PRIMARY KEY)');
    await db.query('INSERT INTO e1 VALUES (1)');
    const e = await db.query('INSERT INTO e1 VALUES (1)').then(
      () => null,
      (x: unknown) => x as { code?: string; constraint?: string },
    );
    expect(e?.code).toBe('23505');
    expect(e?.constraint).toBe('e1_pk');
  });
});
