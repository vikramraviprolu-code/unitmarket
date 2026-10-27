// Applies the numbered SQL migrations to any Database, one transaction per file, each recorded in
// schema_migrations with a time from the injected Clock (never from the database).
// Adapted from AIC_Hackathon_UnitMarket packages/db/src/migrate.ts at a36ddc03fd0b962000f686291c145b50ee337f90.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, Database } from '@umsbx/contracts';

export type MigrationSet = 'common' | 'supabase';

export const MIGRATIONS_ROOT = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Migration {
  version: string;
  sql: string;
}

export function listMigrations(dir: string, prefix = ''): Migration[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      version: prefix + file.replace(/\.sql$/, ''),
      sql: readFileSync(join(dir, file), 'utf8'),
    }));
}

/** Key of the session advisory lock a Postgres run holds while it applies migrations (PG-1). */
export const MIGRATE_LOCK_KEY = 'ums.migrate';

type LockableDatabase = Database & {
  withAdvisoryLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

// Lower level: apply a directory of migrations. Versions are recorded as prefix + file name.
// On Postgres the whole run holds a session advisory lock (the driver's withAdvisoryLock), taken
// before the first statement, so two processes that boot together apply each migration once: the
// second waits, then reads schema_migrations and finds nothing left to do. PGlite has one opener.
export async function applyMigrations(
  db: Database,
  clock: Clock,
  dir: string,
  prefix = '',
): Promise<string[]> {
  const lockable = db as LockableDatabase;
  if (typeof lockable.withAdvisoryLock === 'function') {
    return lockable.withAdvisoryLock(MIGRATE_LOCK_KEY, () => applyUnlocked(db, clock, dir, prefix));
  }
  return applyUnlocked(db, clock, dir, prefix);
}

async function applyUnlocked(
  db: Database,
  clock: Clock,
  dir: string,
  prefix: string,
): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL)',
  );
  const done = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(done.rows.map((row) => row.version));
  const newlyApplied: string[] = [];
  for (const migration of listMigrations(dir, prefix)) {
    if (applied.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        clock.now().toISOString(),
      ]);
    });
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

// 'common' runs on PGlite and Postgres. 'supabase' (roles, grants, RLS) runs only on Supabase.
export function migrate(
  db: Database,
  clock: Clock,
  set: MigrationSet = 'common',
): Promise<string[]> {
  return applyMigrations(
    db,
    clock,
    join(MIGRATIONS_ROOT, set),
    set === 'supabase' ? 'supabase/' : '',
  );
}
