// M1-L9: the bulk seeder of the search suites sets the journal's restore mode (which lifts the insert guard of payouts) so
// it can load many rows in one statement. It is test support, inserts no payout, and must leave the mode off again before
// the script ends, so a payout insert added to it later is not waved through.
import { describe, expect, it, vi } from 'vitest';
import { seedBulkSales } from './search-support';

vi.mock('server-only', () => ({}));

async function scriptOf(): Promise<string> {
  const seen: string[] = [];
  await seedBulkSales(
    {
      exec: (sql: string) => {
        seen.push(sql);
        return Promise.resolve();
      },
    },
    {
      buyer_id: 'vs_b1',
      publisher_id: 'vs_p1',
      merchant: 'M',
      corridor: 'us-usd',
      count: 3,
      prefix: 'bulk',
      from: new Date('2026-10-22T10:00:00.000Z'),
    },
  );
  return seen.join('\n');
}

describe('seedBulkSales and the restore mode', () => {
  it('turns the restore mode on only for its inserts and off again before the script ends', async () => {
    const sql = await scriptOf();
    const sets = [...sql.matchAll(/set_config\('ums\.trace',\s*'([^']*)'/g)];
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(sets[0]![1]).toContain('restore');
    expect(sets.at(-1)![1]).not.toContain('restore');
    const lastSet = sql.lastIndexOf(sets.at(-1)![0]);
    const lastInsert = sql.lastIndexOf('INSERT INTO');
    expect(lastSet).toBeGreaterThan(lastInsert);
  });

  it('writes no payout, settlement or adjustment row', async () => {
    const sql = await scriptOf();
    expect(sql).not.toMatch(/payout|adjustment_settlements/i);
  });
});
