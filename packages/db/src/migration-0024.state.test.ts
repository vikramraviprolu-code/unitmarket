// INT-SR0 (SR0.3): migration 0024 adds the ten search indexes and the txn_rows view, nothing else. No
// extension (no pg_trgm), no table, no default, no change to a money table. Number is the next free one on main
// at merge time (consolidation.md, section 2).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '@umsbx/runtime';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

let db: Database & { close(): Promise<void> };
let applied: string[];
beforeAll(async () => {
  db = await openDatabase({ kind: 'pglite-memory' });
  applied = await migrate(db, fakeClock('2026-11-05T10:00:00.000Z'));
});
afterAll(() => db.close());

const NEW_INDEXES: Record<string, { table: string; columns: RegExp; partial?: RegExp }> = {
  orders_buyer_time: { table: 'orders', columns: /\(buyer_id, created_at DESC, id DESC\)/ },
  orders_time: { table: 'orders', columns: /\(created_at DESC, id DESC\)/ },
  orders_attention: {
    table: 'orders',
    columns: /\(created_at DESC\)/,
    partial: /WHERE .*unresolved.*frozen/s,
  },
  order_units_pub_time: {
    table: 'order_units',
    columns: /\(publisher_id, created_at DESC, id DESC\)/,
  },
  order_units_problem: {
    table: 'order_units',
    columns: /\(updated_at DESC\)/,
    partial: /WHERE .*pending.*mismatch.*reversal_suspected/s,
  },
  refund_requests_unit: {
    table: 'refund_requests',
    columns: /\(unit_id, created_at DESC, id DESC\)/,
  },
  recovery_cases_order: {
    table: 'recovery_cases',
    columns: /\(order_id, created_at DESC, id DESC\)/,
  },
  ledger_entries_unit: { table: 'ledger_entries', columns: /\(unit_id\)/ },
  entitlements_buyer: { table: 'entitlements', columns: /\(buyer_id, created_at DESC\)/ },
  alerts_order: { table: 'alerts', columns: /\(order_id\)/ },
};

describe('migration 0024 (SR0.3)', () => {
  it('is applied, under its name', () => {
    expect(applied).toContain('0024_txn_search');
  });

  it('creates the ten indexes of the spec, with the columns and partial predicates it lists', async () => {
    const rows = await db.query<{ indexname: string; tablename: string; indexdef: string }>(
      `SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.rows.map((r) => [r.indexname, r]));
    expect(Object.keys(NEW_INDEXES)).toHaveLength(10);
    for (const [name, want] of Object.entries(NEW_INDEXES)) {
      const row = byName.get(name);
      expect(row, name).toBeDefined();
      expect(row!.tablename, name).toBe(want.table);
      expect(row!.indexdef, name).toMatch(/USING btree/);
      expect(row!.indexdef, name).toMatch(want.columns);
      if (want.partial) expect(row!.indexdef, name).toMatch(want.partial);
      else expect(row!.indexdef, name).not.toMatch(/ WHERE /);
    }
  });

  it('adds no duplicate: no two indexes on a table have the same definition', async () => {
    const rows = await db.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const seen = new Map<string, number>();
    for (const r of rows.rows) {
      const shape = r.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ /, '');
      seen.set(`${r.tablename} ${shape}`, (seen.get(`${r.tablename} ${shape}`) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('does not add the four indexes that already exist as constraints or indexes', async () => {
    // order_units (order_id): UNIQUE (order_id, reference_id), 0004. entitlements (unit_id): UNIQUE (unit_id,
    // article_id), 0005. provider_orders (order_id): UNIQUE (order_id, position), 0011. Mandate link:
    // mandate_reservations_order_idx, 0021.
    const names = (
      await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
      )
    ).rows.map((r) => r.indexname);
    for (const dropped of ['order_units_order', 'entitlements_unit', 'provider_orders_order'])
      expect(names, dropped).not.toContain(dropped);
    expect(names).toContain('mandate_reservations_order_idx');
    expect(names.filter((n) => /^mandate_reservations_.*_idx$/.test(n))).toHaveLength(2);
  });

  it('needs no extension', async () => {
    const ext = await db.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql')`,
    );
    expect(ext.rows.map((r) => r.extname)).not.toContain('pg_trgm');
    const sql = readFileSync(
      new URL('../migrations/common/0024_txn_search.sql', import.meta.url),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(sql).not.toMatch(/gin_trgm_ops|pg_trgm/i);
  });

  it('adds only indexes and the txn_rows view: no table, no column, no trigger', () => {
    const sql = readFileSync(
      new URL('../migrations/common/0024_txn_search.sql', import.meta.url),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION)/i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect((sql.match(/CREATE\s+INDEX/gi) ?? []).length).toBe(10);
    expect((sql.match(/CREATE\s+VIEW/gi) ?? []).length).toBe(1);
  });

  it('creates txn_rows as a security-invoker view (reloptions)', async () => {
    const r = await db.query<{ relkind: string; reloptions: string[] | null }>(
      `SELECT relkind, reloptions FROM pg_class
        WHERE relname = 'txn_rows' AND relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.relkind).toBe('v');
    expect(r.rows[0]!.reloptions).toContain('security_invoker=true');
  });

  it('keeps the view out of the table list that export and reset use', async () => {
    const t = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'txn_rows'`,
    );
    expect(t.rows).toEqual([]);
  });
});
