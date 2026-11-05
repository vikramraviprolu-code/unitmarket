// BR-2: migration 0027 (rule_settings). One append-only table with CHECKs, one index, and a place in the
// transaction journal (capture trigger plus a trace_tracked row). Forward-only. Tolerates later migrations:
// it never checks an exact list.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TRACKED_TABLES } from '@umsbx/contracts';
import type { Database } from '@umsbx/contracts';
import { MIGRATIONS_ROOT, applyMigrations } from './migrate';
import { migrate, openDatabase } from './index';
import { resetDatabase } from './reset';

const T = '2026-11-05T10:00:00Z';
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
const row = (d: Db, o: Partial<Record<string, unknown>> = {}): Promise<unknown> => {
  const r: Record<string, unknown> = {
    id: 'rls_1',
    rule_key: 'refund.request_window',
    scope_kind: 'platform',
    scope_id: null,
    value: 7,
    effective_from: T,
    effective_until: null,
    set_by: 'opr_x',
    reason: 'fine reason',
    approved_by: null,
    created_at: T,
    ...o,
  };
  const cols = Object.keys(r);
  return d.query(
    `INSERT INTO rule_settings (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
};

describe('migration 0027', () => {
  it('is applied once, after the journal migration, and has no down step and no default', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0027_rule_settings');
    expect(first.indexOf('0027_rule_settings')).toBeGreaterThan(
      first.indexOf('0023_trace_journal'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0027_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0027_rule_settings.sql', dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    const create = sql.slice(
      sql.indexOf('CREATE TABLE rule_settings'),
      sql.indexOf(');', sql.indexOf('CREATE TABLE rule_settings')),
    );
    expect(create).not.toMatch(/\bDEFAULT\b/i);
  });

  it('has exactly the columns of RuleSettingRowSchema', async () => {
    const d = await fresh();
    const r = await d.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'rule_settings' ORDER BY column_name",
    );
    expect(r.rows.map((x) => x.column_name)).toEqual(
      [
        'approved_by',
        'created_at',
        'effective_from',
        'effective_until',
        'id',
        'reason',
        'rule_key',
        'scope_id',
        'scope_kind',
        'set_by',
        'value',
      ].sort(),
    );
    const nullable = r.rows
      .filter((x) => x.is_nullable === 'YES')
      .map((x) => x.column_name)
      .sort();
    expect(nullable).toEqual(['approved_by', 'effective_until', 'scope_id']);
  });

  it('accepts a platform row and one row of each other scope', async () => {
    const d = await fresh();
    await row(d);
    for (const [i, kind] of (['category', 'seller', 'buyer', 'agreement'] as const).entries())
      await row(d, { id: `rls_${i + 2}`, scope_kind: kind, scope_id: `x_${i}` });
  });

  it('refuses a scope kind outside the five, a platform row with a scope id and any other scope without one', async () => {
    const d = await fresh();
    await expect(row(d, { scope_kind: 'planet' })).rejects.toThrow();
    await expect(row(d, { scope_kind: 'platform', scope_id: 'pub_1' })).rejects.toThrow();
    await expect(row(d, { scope_kind: 'seller', scope_id: null })).rejects.toThrow();
  });

  it('refuses a reason shorter than 3 or longer than 200 characters, and accepts 3 and 200', async () => {
    const d = await fresh();
    await expect(row(d, { reason: 'ab' })).rejects.toThrow();
    await expect(row(d, { reason: 'x'.repeat(201) })).rejects.toThrow();
    await row(d, { id: 'rls_a', reason: 'abc' });
    await row(d, { id: 'rls_b', reason: 'x'.repeat(200) });
  });

  it('refuses an end that is not after the start, accepts a later one or none', async () => {
    const d = await fresh();
    await expect(row(d, { effective_until: T })).rejects.toThrow();
    await expect(row(d, { effective_until: '2026-11-05T09:00:00Z' })).rejects.toThrow();
    await row(d, { id: 'rls_a', effective_until: '2026-11-05T10:00:01Z' });
  });

  it('refuses a missing business column (no default) and a duplicate id', async () => {
    const d = await fresh();
    await expect(
      d.query(
        `INSERT INTO rule_settings (id, rule_key, scope_kind, effective_from, set_by, reason, created_at) VALUES ('rls_n', 'refund.request_window', 'platform', $1, 'opr_x', 'fine reason', $1)`,
        [T],
      ),
    ).rejects.toThrow();
    await row(d);
    await expect(row(d)).rejects.toThrow();
  });

  it('is append-only: no update, delete or truncate', async () => {
    const d = await fresh();
    await row(d);
    await expect(d.query('UPDATE rule_settings SET value = 9')).rejects.toThrow(/append-only/);
    await expect(d.query('DELETE FROM rule_settings')).rejects.toThrow(/append-only/);
    await expect(d.exec('TRUNCATE rule_settings')).rejects.toThrow(/TRUNCATE|append-only/);
  });

  it('has the index (rule_key, scope_kind, scope_id, effective_from)', async () => {
    const d = await fresh();
    const r = await d.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'rule_settings' AND indexname <> 'rule_settings_pkey'",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.indexdef).toMatch(/\(rule_key, scope_kind, scope_id, effective_from\)/);
  });

  it('joins the journal: a capture trigger and a trace_tracked row on the platform chain', async () => {
    const d = await fresh();
    const t = await d.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trace_capture_rule_settings'",
    );
    expect(t.rows).toHaveLength(1);
    const k = await d.query<{
      columns: string[];
      hashed_columns: string[];
      time_column: string;
      chain_expr: string;
    }>(
      "SELECT columns, hashed_columns, time_column, chain_expr FROM trace_tracked WHERE table_name = 'rule_settings'",
    );
    expect(k.rows).toHaveLength(1);
    expect(k.rows[0]!.hashed_columns).toEqual(['reason']);
    expect(k.rows[0]!.columns).not.toContain('reason');
    expect(k.rows[0]!.chain_expr).toBe('plat');
    expect(k.rows[0]!.time_column).toBe('created_at');
  });

  it('a row written with a context is journaled once, with the reason only as sha256', async () => {
    const d = await fresh();
    await row(d, { reason: 'CANARY-RULE-REASON' });
    const e = await d.query<{ n: number; body: { hashed: Record<string, unknown[]> } }>(
      "SELECT count(*) OVER ()::int AS n, body FROM trace_events WHERE source_table = 'rule_settings'",
    );
    expect(e.rows).toHaveLength(1);
    expect(JSON.stringify(e.rows[0]!.body)).not.toContain('CANARY-RULE-REASON');
    expect(String(e.rows[0]!.body.hashed['reason']![1])).toMatch(/^[a-f0-9]{64}$/);
  });
});

const trackedNames = async (d: Db): Promise<string[]> =>
  (
    await d.query<{ table_name: string }>(
      'SELECT table_name FROM trace_tracked ORDER BY table_name',
    )
  ).rows.map((r) => r.table_name);

describe('the reseed wrapper', () => {
  it('after a reset (TRUNCATE fires the reseed) trace_tracked holds every tracked table, rule_settings included', async () => {
    const d = await fresh();
    await resetDatabase(d);
    const names = await trackedNames(d);
    expect(names).toHaveLength(TRACKED_TABLES.length);
    expect(names).toContain('rule_settings');
    expect(names).toEqual(TRACKED_TABLES.map((t) => t.table).sort());
  });

  it('leaves 0023’s seed function, reseed function and trigger alone and adds only names with its own number', async () => {
    const d = await fresh();
    const f = await d.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname LIKE 'trace_tracked_%' ORDER BY proname",
    );
    const names = f.rows.map((r) => r.proname);
    expect(names).toEqual(
      expect.arrayContaining([
        'trace_tracked_seed',
        'trace_tracked_reseed',
        'trace_tracked_seed_0027',
        'trace_tracked_reseed_0027',
      ]),
    );
    expect(names.some((n) => /trace_tracked_seed_0023|before/.test(n))).toBe(false);
    const sql = readFileSync(
      new URL('../migrations/common/0027_rule_settings.sql', import.meta.url),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(sql).not.toMatch(
      /ALTER FUNCTION|DROP FUNCTION|CREATE OR REPLACE FUNCTION trace_tracked_(seed|reseed)\(/i,
    );
  });

  it('another lane that follows the same convention, numbered before 0027, applies cleanly and both survive a reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'umsbx-wrap-'));
    try {
      for (const f of readdirSync(join(MIGRATIONS_ROOT, 'common')))
        cpSync(join(MIGRATIONS_ROOT, 'common', f), join(dir, f));
      // The highest number below 0027 that no migration uses (0026 today), so a real lane never collides with it.
      const used = new Set(readdirSync(dir).map((f) => Number(f.slice(0, 4))));
      let n = 26;
      while (used.has(n) && n > 0) n -= 1;
      const num = String(n).padStart(4, '0');
      writeFileSync(
        join(dir, `${num}_zz_probe_lane.sql`),
        `CREATE TABLE probe_lane (id ums_id PRIMARY KEY, created_at timestamptz NOT NULL);
CREATE FUNCTION trace_tracked_seed_${num}() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO trace_tracked (table_name, columns, hashed_columns, digest_columns, time_column, chain_expr) VALUES
    ('probe_lane', ARRAY['id'], ARRAY[]::text[], ARRAY[]::text[], 'created_at', 'plat')
  ;
$fn$;
CREATE FUNCTION trace_tracked_reseed_${num}() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN PERFORM trace_tracked_seed_${num}(); RETURN NULL; END;
$fn$;
CREATE TRIGGER trace_tracked_reseed_${num} AFTER TRUNCATE ON trace_tracked
  FOR EACH STATEMENT EXECUTE FUNCTION trace_tracked_reseed_${num}();
SELECT trace_tracked_seed_${num}();
`,
      );
      const d = await openDatabase({ kind: 'pglite-memory' });
      toClose.push(d);
      const applied = await applyMigrations(d, clock, dir);
      expect(applied).toContain(`${num}_zz_probe_lane`);
      expect(applied).toContain('0027_rule_settings');
      expect(await trackedNames(d)).toEqual(
        expect.arrayContaining(['probe_lane', 'rule_settings']),
      );
      expect(await trackedNames(d)).toHaveLength(TRACKED_TABLES.length + 1);
      await resetDatabase(d);
      const after = await trackedNames(d);
      expect(after).toHaveLength(TRACKED_TABLES.length + 1);
      expect(after).toEqual(expect.arrayContaining(['probe_lane', 'rule_settings']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
