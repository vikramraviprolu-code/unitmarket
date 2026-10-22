// @umsbx/db: PGlite driver, migration runner and the complete MVP-A schema (lane 12).
export const PACKAGE_NAME = '@umsbx/db' as const;
export type { DbTarget, SqlDriver } from './driver';
export { openDatabase } from './pglite';
export { migrate, applyMigrations, listMigrations, MIGRATIONS_ROOT } from './migrate';
export type { MigrationSet } from './migrate';
export { resetDatabase } from './reset';
export { tablesInDependencyOrder } from './export-sql';
