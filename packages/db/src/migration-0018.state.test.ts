// MC2-L5 (D-084 item 4): migration 0018 adds the buyer's display currency to buyers. One nullable column,
// no default (null means "derive it from the country"), restricted to USD, EUR or GBP, forward-only.
// Tolerates later migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-11-04T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
}
const buyer = (d: Db, id: string, display: string | null | undefined) =>
  display === undefined
    ? d.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, 'B', $3, 'DE', $2, $2)`,
        [id, T, `sub-${id}`],
      )
    : d.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, display_currency, created_at, updated_at)
         VALUES ($1, 'B', $4, 'DE', $3, $2, $2)`,
        [id, T, display, `sub-${id}`],
      );

describe('migration 0018', () => {
  it('is applied once, after 0017, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0018_buyer_display_currency');
    expect(first.indexOf('0018_buyer_display_currency')).toBeGreaterThan(
      first.indexOf('0017_fx_rates'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0018_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0018_buyer_display_currency.sql', dir), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('adds one nullable text column with no default, and changes nothing else on buyers', async () => {
    const d = await fresh();
    const cols = (
      await d.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'buyers' ORDER BY column_name`,
      )
    ).rows;
    expect(cols.map((c) => c.column_name)).toEqual([
      'auth_subject',
      'country',
      'created_at',
      'display_currency',
      'display_name',
      'id',
      'updated_at',
    ]);
    const c = cols.find((x) => x.column_name === 'display_currency')!;
    expect([c.data_type, c.is_nullable, c.column_default]).toEqual(['text', 'YES', null]);
  });

  it('a buyer stored without a choice has null; USD, EUR and GBP are accepted; nothing else is', async () => {
    const d = await fresh();
    await buyer(d, 'buy_a', undefined);
    await buyer(d, 'buy_b', null);
    await buyer(d, 'buy_c', 'EUR');
    await buyer(d, 'buy_d', 'USD');
    await buyer(d, 'buy_e', 'GBP');
    const rows = (
      await d.query<{ id: string; display_currency: string | null }>(
        'SELECT id, display_currency FROM buyers ORDER BY id',
      )
    ).rows;
    expect(rows.map((r) => r.display_currency)).toEqual([null, null, 'EUR', 'USD', 'GBP']);
    for (const bad of ['JPY', 'usd', 'XAU', '', 'EUR ']) {
      await expect(buyer(d, `buy_x_${bad}`, bad), bad).rejects.toThrow();
    }
  });
});
