// The driver abstraction. PGlite (default) and node-postgres (dialect 'pg', PG-1, D-050) both sit
// behind the plain Database port from lane 01 F1.
import type { Database } from '@umsbx/contracts';

/** Named options of the Postgres target. Every one has a safe default (pg.ts). */
export interface PgOptions {
  /** Most connections the pool opens. Whole number 1 to 100; default 5. */
  pool_max?: number;
  /** Server-side statement timeout in milliseconds; default 30000. */
  statement_timeout_ms?: number;
  /** Time allowed to open a connection (and to wait for a free one) in milliseconds; default 10000. */
  connect_timeout_ms?: number;
}

/**
 * `postgres` takes the DATABASE_URL value (a secret: the driver never logs it and scrubs it from
 * every error). Forms: postgres://u:p@host:5432/db?sslmode=require and the Cloud SQL socket form
 * postgres://u:p@/db?host=/cloudsql/PROJECT:REGION:INSTANCE.
 */
export type DbTarget =
  | { kind: 'pglite-memory' }
  | { kind: 'pglite-disk'; dir: string }
  | ({ kind: 'postgres'; url: string } & PgOptions);

/**
 * A held leader lease (PG-2). `held()` is false as soon as the lock connection is gone, `lost`
 * resolves at that moment, and `release()` gives the lock back (harmless when already lost).
 */
export interface AdvisoryLease {
  held(): boolean;
  readonly lost: Promise<void>;
  release(): Promise<void>;
}

// `target` says where the driver runs; resetDatabase (tests only) reads it.
// `withAdvisoryLock` exists on the Postgres driver only: it holds a session-level advisory lock on a
// dedicated connection (outside the pool) while `fn` runs. migrate() uses it when present.
export type SqlDriver = Database & {
  close(): Promise<void>;
  readonly target: DbTarget['kind'];
  withAdvisoryLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Postgres only (PG-2): try once, without waiting, to take the session lock `key` on a dedicated
   * connection. A lease when taken, null when another session holds it. Used for the job loop leader.
   */
  tryAdvisoryLock?(key: string): Promise<AdvisoryLease | null>;
};
