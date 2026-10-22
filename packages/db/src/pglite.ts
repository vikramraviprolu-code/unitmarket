import { PGlite } from '@electric-sql/pglite';
import type { SqlDriver, DbTarget } from './driver';
import type { SqlExecutor } from './temp-contracts-f1';

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
  const base = executor(pg);
  return {
    dialect: 'pglite',
    query: base.query,
    exec: base.exec,
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      pg.transaction((tx) => fn(executor(tx))),
    close: () => pg.close(),
  };
}
