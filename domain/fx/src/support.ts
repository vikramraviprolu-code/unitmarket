// MC2-L4 test helper: a migrated in-memory database (the seed rates of migration 0017 are in it) and a
// clock that moves only when the test says so. Never imported by product code.
import { migrate, openDatabase } from '@umsbx/db';
import type { SqlDriver } from '@umsbx/db';
import { fakeClock } from '@umsbx/runtime';

export interface FxWorld {
  db: SqlDriver;
  clock: ReturnType<typeof fakeClock>;
}

export async function fxWorld(startIso: string = '2026-11-04T09:00:00Z'): Promise<FxWorld> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(startIso);
  await migrate(db, clock);
  return { db, clock };
}

/** What the seed rows of migration 0017 say. */
export const SEED = {
  date: '2026-11-03',
  usd: 1.15,
  gbp: 0.87,
  fetched_at: '2026-11-03T16:00:00.000Z',
} as const;
