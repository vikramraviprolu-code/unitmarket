import { PGlite } from '@electric-sql/pglite';
import type { SqlDriver, DbTarget } from './driver';
import { withSerializationRetry } from './retry';
import type { SqlExecutor } from '@umsbx/contracts';
import { acquireLock } from './lock';
import type { LockDeps } from './lock';

function executor(q: Pick<PGlite, 'query' | 'exec'>): SqlExecutor {
  return {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const r = await q.query<T>(sql, params);
      return { rows: r.rows };
    },
    exec: async (sql: string) => {
      await q.exec(sql);
    },
  };
}

/** Options for openDatabase. Only the disk target uses them (the lock); defaults suit production. */
export type OpenOptions = LockDeps;

// Opens PGlite in memory or on a data directory on disk (one long-running process owns the dir).
// A disk target first takes `<dir>/.ums-open.lock` (lock.ts): a second opener gets DbInUseError, and
// close() or process exit removes the lock. Memory targets take no lock.
export async function openDatabase(t: DbTarget, opts: OpenOptions = {}): Promise<SqlDriver> {
  const lock = t.kind === 'pglite-disk' ? acquireLock(t.dir, opts) : null;
  try {
    const driver = await openPglite(t);
    if (lock === null) return driver;
    return {
      ...driver,
      close: async () => {
        try {
          await driver.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (e) {
    lock?.release();
    throw e;
  }
}

async function openPglite(t: DbTarget): Promise<SqlDriver> {
  const pg = t.kind === 'pglite-memory' ? new PGlite() : new PGlite(t.dir);
  await pg.waitReady;
  // Marks the in-memory target for the TRUNCATE guard (migration 0001); disk targets never get it.
  if (t.kind === 'pglite-memory')
    await pg.query("SELECT set_config('ums.db_target', 'memory', false)");
  const base = executor(pg);
  // PGlite never raises a deadlock or a serialization failure; the wrapper is in the path so the
  // retry rule is the same one a node-postgres adapter will use (retry.ts).
  return withSerializationRetry<SqlDriver>({
    dialect: 'pglite',
    target: t.kind,
    query: base.query,
    exec: base.exec,
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      pg.transaction((tx) => fn(executor(tx))),
    close: () => pg.close(),
  });
}
