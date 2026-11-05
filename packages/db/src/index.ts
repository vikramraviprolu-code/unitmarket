// @umsbx/db: PGlite and Postgres drivers, migration runner and the complete MVP-A schema (lane 12).
export const PACKAGE_NAME = '@umsbx/db' as const;
export type { AdvisoryLease, DbTarget, PgOptions, SqlDriver } from './driver';
export { parsePgUrl, PgConfigError, PgConnectionError } from './pg';
export type { ParsedPgUrl } from './pg';
export { openDatabase } from './pglite';
export type { OpenOptions } from './pglite';
export {
  LOCK_FILE,
  LOCK_BREAK_FILE,
  DbInUseError,
  DbLockRefusedError,
  acquireLock,
  inspectLock,
  releaseLock,
  processIsAlive,
} from './lock';
export type { LockDeps, LockHandle, LockInfo, LockInspection, LockRefusalCode } from './lock';
export {
  migrate,
  applyMigrations,
  listMigrations,
  MIGRATIONS_ROOT,
  MIGRATE_LOCK_KEY,
} from './migrate';
export type { MigrationSet } from './migrate';
export { tablesInDependencyOrder } from './export-sql';
export { withSerializationRetry, isRetryableSqlError } from './retry';
// INT-TR0 (transaction journal).
export { withTraceDb, traceSetting } from './trace-db';
export { verifyTrace, traceInvariants, formatTraceFinding } from './trace-verify';
export type { TraceFinding, TraceReport } from './trace-verify';
