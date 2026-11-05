// MC2-L4 (D-084 items 4 and 5, D-085): migration 0017 (fx_rates). One new table, no defaults, forward-only,
// append-only, EUR based, with a clearly marked seed set. Run on in-memory SQL, and on real Postgres when
// UMS_TEST_DB=postgres (UMS_TEST_PG_BIN names the server binaries). Tolerates later migrations.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { exportSql, importSql } from './export-sql';
import { applyMigrations, MIGRATIONS_ROOT, migrate, openDatabase } from './index';

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
const row = (
  d: Db,
  v: { date?: string; base?: string; quote?: string; rate?: string; source?: string } = {},
) =>
  d.query(
    `INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      v.date ?? '2026-11-04',
      v.base ?? 'EUR',
      v.quote ?? 'USD',
      v.rate ?? '1.16',
      v.source ?? 'ecb',
      T,
    ],
  );

describe('migration 0017', () => {
  it('is applied once, after 0016, and has no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0017_fx_rates');
    expect(first.indexOf('0017_fx_rates')).toBeGreaterThan(first.indexOf('0016_buyer_accounts'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0017_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0017_fx_rates.sql', dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('says in its header that the seed rows are seed values and the table is append-only', () => {
    const raw = readFileSync(
      new URL('../migrations/common/0017_fx_rates.sql', import.meta.url),
      'utf8',
    );
    const header = raw.split('CREATE TABLE')[0]!.replace(/\s+/g, ' ');
    expect(header).toMatch(/seed/i);
    expect(header).toMatch(/not ECB|not an ECB|not real ECB|placeholder|made-up|round numbers/i);
    expect(header).toMatch(/append-only/i);
    expect(header).toMatch(/D-085/);
  });

  it('has the columns of the spec, primary key (date, quote), and nothing else', async () => {
    const d = await fresh();
    const cols = (
      await d.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'fx_rates' ORDER BY column_name`,
      )
    ).rows;
    expect(cols.map((c) => c.column_name)).toEqual([
      'base',
      'date',
      'fetched_at',
      'quote',
      'rate',
      'source',
    ]);
    expect(cols.every((c) => c.is_nullable === 'NO' && c.column_default === null)).toBe(true);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    expect(by['date']).toBe('date');
    expect(by['rate']).toBe('numeric');
    expect(by['fetched_at']).toBe('timestamp with time zone');
    const pk = (
      await d.query<{ column_name: string }>(
        `SELECT a.attname AS column_name FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = 'fx_rates'::regclass AND i.indisprimary ORDER BY a.attname`,
      )
    ).rows;
    expect(pk.map((r) => r.column_name)).toEqual(['date', 'quote']);
  });

  it('carries one seed set for one recent ECB date, marked source seed, USD and GBP', async () => {
    const d = await fresh();
    const rows = (
      await d.query<{
        date: string;
        base: string;
        quote: string;
        rate: string;
        source: string;
        fetched_at: Date;
      }>(
        `SELECT date::text AS date, base, quote, rate::text AS rate, source, fetched_at FROM fx_rates ORDER BY quote`,
      )
    ).rows;
    expect(rows.map((r) => [r.quote, r.base, r.source, r.date])).toEqual([
      ['GBP', 'EUR', 'seed', '2026-11-03'],
      ['USD', 'EUR', 'seed', '2026-11-03'],
    ]);
    const rate = Object.fromEntries(rows.map((r) => [r.quote, Number(r.rate)]));
    expect(rate['USD']).toBe(1.15);
    expect(rate['GBP']).toBe(0.87);
    expect(rows[0]!.fetched_at.toISOString()).toBe('2026-11-03T16:00:00.000Z');
  });

  it('refuses a rate of zero or below, another base, another quote and another source', async () => {
    const d = await fresh();
    for (const bad of [
      { rate: '0' },
      { rate: '-1.1' },
      { base: 'USD' },
      { quote: 'JPY' },
      { quote: 'EUR' },
      { source: 'manual' },
      { source: 'ECB' },
    ]) {
      await expect(row(d, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(row(d, { date: '2026-13-01' })).rejects.toThrow();
  });

  it('takes an ECB row, refuses the same (date, quote) twice and takes the other quote', async () => {
    const d = await fresh();
    await row(d, { quote: 'USD' });
    await row(d, { quote: 'GBP', rate: '0.88' });
    await expect(row(d, { quote: 'USD', rate: '1.17' })).rejects.toThrow();
    expect(
      Number(
        (
          await d.query<{ c: string | number }>(
            `SELECT count(*) AS c FROM fx_rates WHERE source = 'ecb'`,
          )
        ).rows[0]!.c,
      ),
    ).toBe(2);
  });

  it('is append-only: update, delete and truncate are refused', async () => {
    const d = await fresh();
    await expect(d.query(`UPDATE fx_rates SET rate = 2`)).rejects.toThrow(/append-only/);
    await expect(d.query(`DELETE FROM fx_rates`)).rejects.toThrow(/append-only/);
    await expect(d.query(`TRUNCATE fx_rates`)).rejects.toThrow(/append-only/);
    expect(
      Number(
        (await d.query<{ c: string | number }>('SELECT count(*) AS c FROM fx_rates')).rows[0]!.c,
      ),
    ).toBe(2);
  });

  it('survives a logical export and import: the seed rows are replaced, ECB rows come across, the guard is back on', async () => {
    const src = await fresh();
    await row(src, { quote: 'USD' });
    await row(src, { quote: 'GBP', rate: '0.88' });
    const dst = await fresh();
    const counts = await importSql(dst, await exportSql(src, { utc: T }));
    expect(counts['fx_rates']).toBe(4);
    const all = (d: Db) =>
      d.query(`SELECT to_jsonb(x)::text AS r FROM fx_rates x ORDER BY 1`).then((r) => r.rows);
    expect(await all(dst)).toEqual(await all(src));
    await expect(dst.query('DELETE FROM fx_rates')).rejects.toThrow(/append-only/);
    // A database that already holds an ECB row is not fresh: the import refuses it.
    await expect(importSql(src, await exportSql(src, { utc: T }))).rejects.toThrow(/not empty/);
  });

  it('a failed import leaves the fx_rates delete guard enabled and the seed rows in place', async () => {
    const src = await fresh();
    const lines = (await exportSql(src, { utc: T })).split('\n');
    const fxLine = lines.find((l) => l.startsWith('INSERT INTO "fx_rates"'))!;
    // The same table twice: the second load meets the primary key and the whole import rolls back.
    const bad = [...lines, fxLine].join('\n');
    const dst = await fresh();
    await expect(importSql(dst, bad)).rejects.toThrow();
    const trig = await dst.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'fx_rates_append_only'`,
    );
    expect(trig.rows).toEqual([{ tgenabled: 'O' }]);
    await expect(dst.query('DELETE FROM fx_rates')).rejects.toThrow(/append-only/);
    expect(
      Number(
        (await dst.query<{ c: string | number }>('SELECT count(*) AS c FROM fx_rates')).rows[0]!.c,
      ),
    ).toBe(2);
  });

  it('applies on a database that already holds data from 0001 to 0016 and changes nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig-'));
    try {
      const common = join(MIGRATIONS_ROOT, 'common');
      for (const f of readdirSync(common).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0017'))
        cpSync(join(common, f), join(dir, f));
      const d = await openDatabase({ kind: 'pglite-memory' });
      toClose.push(d);
      const before = await applyMigrations(d, clock, dir);
      expect(before.at(-1)).toBe('0016_buyer_accounts');
      await d.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_x', 'X', 'sx', 'GB', $1, $1)`,
        [T],
      );
      const tables = async () =>
        (
          await d.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
          )
        ).rows.map((r) => r.tablename);
      const t0 = await tables();
      // Later migrations (0018 from MC2-L5, 0019 api keys from API-W0, 0020 webhooks from API-C) follow it; only the first one applied is 0017.
      expect((await migrate(d, clock))[0]).toBe('0017_fx_rates');
      expect(
        (await tables()).filter(
          (t) =>
            !t0.includes(t) &&
            ![
              'api_keys',
              'event_outbox',
              'mandates',
              'mandate_reservations',
              'agent_purchases',
              'webhook_subscriptions',
              'webhook_fanout',
              'webhook_deliveries',
              // INT-TR0 (migration 0023): the journal.
              'trace_context',
              'trace_events',
              'trace_heads',
              'trace_seals',
              'trace_tracked',
              // BR-2 (migration 0027): rule settings.
              'rule_settings',
              // POB-M1 (migration 0029): the fee on top and the payouts.
              'fee_settings',
              'offer_price_parts',
              'order_unit_parts',
              'payouts',
              'payout_items',
              'adjustment_settlements',
            ].includes(t),
        ),
      ).toEqual(['fx_rates']);
      expect((await d.query('SELECT id FROM buyers')).rows).toEqual([{ id: 'buy_x' }]);
      expect(
        Number(
          (await d.query<{ c: string | number }>('SELECT count(*) AS c FROM fx_rates')).rows[0]!.c,
        ),
      ).toBe(2);
      expect(await migrate(d, clock)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
