// @umsbx/db: PGlite driver, migration runner and the complete MVP-A schema (lane 12).
export const PACKAGE_NAME = '@umsbx/db' as const;
export type { DbTarget, SqlDriver } from './driver';
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
export { migrate, applyMigrations, listMigrations, MIGRATIONS_ROOT } from './migrate';
export type { MigrationSet } from './migrate';
export { tablesInDependencyOrder } from './export-sql';
export { withSerializationRetry, isRetryableSqlError } from './retry';
