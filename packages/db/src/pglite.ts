import { PGlite } from '@electric-sql/pglite';
import type { SqlDriver, DbTarget } from './driver';
import { withSerializationRetry } from './retry';
import type { SqlExecutor } from '@umsbx/contracts';

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

// Opens PGlite in memory or on a data directory on disk (one long-running process owns the dir).
export async function openDatabase(t: DbTarget): Promise<SqlDriver> {
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
