// Test helper only (never exported from index.ts): a migrated in-memory PGlite database.
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Database } from '@umsbx/contracts';

export const T0 = '2026-10-21T10:00:00.000Z';

export async function testDb(): Promise<Database & { close(): Promise<void> }> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  await migrate(db, fakeClock(T0));
  return db;
}
export { fakeClock, seededIds };
