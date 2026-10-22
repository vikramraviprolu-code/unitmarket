// The migrated test database the domain test worlds each rebuild today (entitlements world.ts,
// catalogue support.ts, ...). A world can call testDb() instead of repeating openDatabase +
// migrate. Lane 16 offers it; the domain worlds are not rewritten here.
import { migrate, openDatabase } from '@umsbx/db';
import type { Database } from '@umsbx/contracts';
import { T0, fakeClock } from './clock';

/**
 * A fresh PGlite in memory, all common migrations applied. Seed rows come from the migrations:
 * the us-usd corridor, the access policies and the six safety switches (paypal_outbound off).
 * Every call returns a new, independent database, so tests never share state. The in-memory
 * target is marked, so `resetDatabase` from `@umsbx/db/testing` works on it.
 */
export async function testDb(): Promise<
  Database & { readonly target: 'pglite-memory'; close(): Promise<void> }
> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  await migrate(db, fakeClock(T0));
  return db as typeof db & { readonly target: 'pglite-memory' };
}
