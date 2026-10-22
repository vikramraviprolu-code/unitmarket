// Applies the numbered SQL migrations to any Database, one transaction per file, each recorded in
// schema_migrations with a time from the injected Clock (never from the database).
// Adapted from AIC_Hackathon_UnitMarket packages/db/src/migrate.ts at a36ddc03fd0b962000f686291c145b50ee337f90.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, Database } from './temp-contracts-f1';

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

// Lower level: apply a directory of migrations. Versions are recorded as prefix + file name.
export async function applyMigrations(
  db: Database,
  clock: Clock,
  dir: string,
  prefix = '',
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
