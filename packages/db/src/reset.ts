// Adapted from AIC_Hackathon_UnitMarket packages/db/src/database.ts (resetDatabase) at
// a36ddc03fd0b962000f686291c145b50ee337f90, with the guard setting renamed ums.allow_reset.
import type { Database } from '@umsbx/contracts';
import type { DbTarget } from './driver';

export interface ResetOptions {
  /** Needed (with env UMS_TEST_RESET=1) to reset a target that is not in memory. */
  confirm?: 'RESET_TEST_DATABASE';
}

// Empties every application table (not schema_migrations) in one statement. TRUNCATE does not fire
// the row-level append-only triggers, so migration 0001 guards those tables with BEFORE TRUNCATE
// triggers that refuse unless ums.allow_reset is 'on' and ums.db_target is 'memory' or 'test'.
// This is the only code that sets them after open. One exec string is one implicit transaction, so
// set_config(..., true) holds for the TRUNCATE alone and falls back by itself afterwards. Seed rows
// (corridor, policies, switches) are removed too; tests that need them insert their own.
//
// For tests only: it is exported from `@umsbx/db` testing entry (src/testing.ts), not from the
// production entry. It refuses unless the driver reports an in-memory target, or the caller passes
// confirm: 'RESET_TEST_DATABASE' and the environment sets UMS_TEST_RESET=1 (a disposable disk test
// database). A driver that does not report its target is treated as not in memory.
export async function resetDatabase(
  db: Database & { readonly target?: DbTarget['kind'] },
  options: ResetOptions = {},
): Promise<void> {
  const inMemory = db.target === 'pglite-memory';
  const flagged = options.confirm === 'RESET_TEST_DATABASE' && process.env.UMS_TEST_RESET === '1';
  if (!inMemory && !flagged) {
    throw new Error(
      'resetDatabase refused: the target is not an in-memory test database (disk targets need confirm and UMS_TEST_RESET=1)',
    );
  }
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename",
  );
  if (tables.rows.length === 0) return;
  await db.exec(
    `SELECT set_config('ums.allow_reset', 'on', true), set_config('ums.db_target', '${inMemory ? 'memory' : 'test'}', true); TRUNCATE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
}
