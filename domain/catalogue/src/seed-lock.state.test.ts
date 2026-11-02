// SEED-RACE (docs/specs/catalogue-seed-race.md): the seed transaction takes an advisory lock before it
// reads or writes anything, so two simultaneous boots on one empty database run one after the other.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '@umsbx/contracts';
import { seedCatalogue } from './index';
import { fakeClock, seededIds, T0, testDb } from './support';

const seedJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/catalogue/seed.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

describe('seedCatalogue takes a transaction lock first', () => {
  it('runs pg_advisory_xact_lock as the first statement of its transaction, and seeds as before', async () => {
    const db = await testDb();
    const seen: string[] = [];
    const real = db.transaction.bind(db);
    const spied = Object.create(db, {
      transaction: {
        value: (fn: (tx: SqlExecutor) => Promise<unknown>) =>
          real((tx: SqlExecutor) =>
            fn({
              ...tx,
              query: (sql: string, params?: unknown[]) => {
                seen.push(sql);
                return tx.query(sql, params);
              },
            } as SqlExecutor),
          ),
      },
    }) as Database;
    const counts = await seedCatalogue(spied, fakeClock(T0), seededIds('seed-lock'), seedJson);
    expect(seen[0]).toMatch(/pg_advisory_xact_lock/);
    expect(counts.publishers).toBeGreaterThan(0);
    expect(counts.articles).toBeGreaterThan(0);
    expect(counts.offers).toBeGreaterThan(0);
    await db.close();
  });
});
