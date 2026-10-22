// Adapted from AIC_Hackathon_UnitMarket packages/db/src/database.ts (resetDatabase) at
// a36ddc03fd0b962000f686291c145b50ee337f90, with the guard setting renamed ums.allow_reset.
import type { Database } from './temp-contracts-f1';

// Empties every application table (not schema_migrations) in one statement. TRUNCATE does not fire
// the row-level append-only triggers, so migration 0001 guards those tables with BEFORE TRUNCATE
// triggers that refuse unless ums.allow_reset is 'on'. This is the only code that sets it. One
// exec string is one implicit transaction, so set_config(..., true) holds for the TRUNCATE alone
// and falls back by itself afterwards. Seed rows (corridor, policies, switches) are removed too;
// tests that need them insert their own. For tests only.
export async function resetDatabase(db: Database): Promise<void> {
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename",
  );
  if (tables.rows.length === 0) return;
  await db.exec(
    `SELECT set_config('ums.allow_reset', 'on', true); TRUNCATE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
}
