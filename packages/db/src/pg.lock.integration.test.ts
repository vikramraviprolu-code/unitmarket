// PG-2: the leader lock on the Postgres driver. A session-level pg_try_advisory_lock on a dedicated
// connection that is not part of the pool; a dropped connection is reported at once. Real Postgres 16
// only (UMS_TEST_PG_BIN); a throwaway server on a unix socket.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from './pglite';
import { pgBinConfigured, startTestPostgres } from './pg-testing';
import type { TestPostgres } from './pg-testing';
import type { SqlDriver } from './driver';

const KEY = 'umsbx:test-leader';

describe.skipIf(!pgBinConfigured())('PG-2 tryAdvisoryLock (real Postgres)', () => {
  let server: TestPostgres;
  let url: string;
  const opened: SqlDriver[] = [];
  const open = async (pool_max = 3): Promise<SqlDriver> => {
    const d = await openDatabase({ kind: 'postgres', url, pool_max });
    opened.push(d);
    return d;
  };
  beforeAll(async () => {
    server = await startTestPostgres();
    url = (await server.createDatabase('pg2_lock')).url;
  }, 120_000);
  afterAll(async () => {
    for (const d of opened) await d.close().catch(() => undefined);
    await server?.stop();
  });

  const lock = (d: SqlDriver, key = KEY) => {
    if (d.tryAdvisoryLock === undefined)
      throw new Error('the Postgres driver has no tryAdvisoryLock');
    return d.tryAdvisoryLock(key);
  };
  const killLockHolders = async (d: SqlDriver): Promise<number> =>
    (
      await d.query(
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid()`,
      )
    ).rows.length;

  it('the first caller holds the lock, a second gets null, a release hands it over', async () => {
    const a = await open();
    const b = await open();
    const first = await lock(a);
    expect(first).not.toBeNull();
    expect(first!.held()).toBe(true);
    expect(await lock(b)).toBeNull();
    expect(await lock(a)).toBeNull(); // same driver, another connection: still one holder
    await first!.release();
    expect(first!.held()).toBe(false);
    const second = await lock(b);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('PGlite has no such method: only the Postgres driver offers it', async () => {
    const mem = await openDatabase({ kind: 'pglite-memory' });
    try {
      expect(mem.tryAdvisoryLock).toBeUndefined();
    } finally {
      await mem.close();
    }
  });

  it('a different key is a different lock', async () => {
    const a = await open();
    const one = await lock(a, 'umsbx:key-one');
    const two = await lock(a, 'umsbx:key-two');
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    await one!.release();
    await two!.release();
  });

  it('a killed lock connection ends the lease at once and frees the lock for the next caller', async () => {
    const a = await open();
    const b = await open();
    const lease = await lock(a);
    expect(lease).not.toBeNull();
    expect(await killLockHolders(b)).toBeGreaterThan(0);
    await Promise.race([
      lease!.lost,
      new Promise((_, rej) => setTimeout(() => rej(new Error('lost never resolved')), 5_000)),
    ]);
    expect(lease!.held()).toBe(false);
    const next = await lock(b);
    expect(next).not.toBeNull();
    await next!.release();
    await lease!.release(); // releasing a lost lease is harmless
  });

  it('the lock connection is not a pooled one: a pool of 1 still answers while the lock is held', async () => {
    const a = await open(1);
    const lease = await lock(a);
    expect(lease).not.toBeNull();
    expect((await a.query<{ n: number }>('SELECT 1 AS n')).rows[0]?.n).toBe(1);
    await lease!.release();
  });

  it('closing the driver releases the lock', async () => {
    const a = await open();
    const b = await open();
    const lease = await lock(a);
    expect(lease).not.toBeNull();
    await a.close();
    expect(lease!.held()).toBe(false);
    const next = await lock(b);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('a lock taken after the driver is closed is refused', async () => {
    const a = await open();
    await a.close();
    await expect(lock(a)).rejects.toThrow(/closed/);
  });
});
