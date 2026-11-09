// WW-COR: migration 0034, worldwide payee corridors (docs/specs/db-ww-corridors.md). Forward-only.
// us-usd, gb-gbp and de-eur become enabled rows whose payee countries are every ISO 3166-1 alpha-2 code except
// IN (ids and currencies never change); in-eur and in-gbp are new, shaped like in-usd; a constraint trigger refuses
// two enabled rows of one currency that share a payee country. The 0034 country literal is proven equal to the one
// constant in @umsbx/contracts. Tolerates later migrations: it never checks an exact list of files.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ISO_3166_1_ALPHA2, WORLDWIDE_PAYEE_COUNTRIES } from '@umsbx/contracts';
import type { Database } from '@umsbx/contracts';
import { MIGRATIONS_ROOT, applyMigrations, migrate, openDatabase } from './index';

const T = '2026-11-09T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
const FILE = '0034_ww_corridors';
const common = join(MIGRATIONS_ROOT, 'common');
const EPOCH = '1970-01-01T00:00:00.000Z';

interface Row {
  id: string;
  currency: string;
  minor_units: number;
  buyer_countries: string[];
  payee_countries: string[];
  domestic_supported: boolean;
  min_charge_minor: number | string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
const rows = async (d: Db): Promise<Row[]> =>
  (
    await d.query<Row>(
      `SELECT id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled,
              created_at, updated_at
         FROM corridors ORDER BY id`,
    )
  ).rows.map((r) => ({
    ...r,
    payee_countries: [...r.payee_countries].sort(),
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  }));
const byId = (all: Row[], id: string): Row => {
  const r = all.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no corridor ${id}`);
  return r;
};

const WORLD = [...WORLDWIDE_PAYEE_COUNTRIES].sort();
const wide = (id: string, currency: string): Row => ({
  id,
  currency,
  minor_units: 2,
  buyer_countries: ['*'],
  payee_countries: WORLD,
  domestic_supported: true,
  min_charge_minor: null,
  enabled: true,
  created_at: EPOCH,
  updated_at: EPOCH,
});
const india = (id: string, currency: string): Row => ({
  id,
  currency,
  minor_units: 2,
  buyer_countries: ['*'],
  payee_countries: ['IN'],
  domestic_supported: false,
  min_charge_minor: null,
  enabled: true,
  created_at: EPOCH,
  updated_at: EPOCH,
});

/** A database migrated up to, but not including, 0034: the state a deployed database is in. */
async function before0034(): Promise<{ d: Db; dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'ums-mig34-'));
  for (const f of readdirSync(common).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0034'))
    cpSync(join(common, f), join(dir, f));
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await applyMigrations(d, clock, dir);
  return { d, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const addFile = (dir: string): void =>
  cpSync(join(common, `${FILE}.sql`), join(dir, `${FILE}.sql`));
const insertNarrow = (d: Db, id: string, cur: string, payee: string[], buyers: string[]) =>
  d.query(
    `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
     VALUES ($1, $2, 2, $3, $4, true, NULL, false, $5, $5)`,
    [id, cur, buyers, payee, T],
  );

describe('migration 0034: applied once, forward only', () => {
  it('is applied once, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain(FILE);
    expect(first.indexOf(FILE)).toBeGreaterThan(first.indexOf('0033_in_usd_corridor'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((x) => /^0034_.*(down|rollback)/i.test(x))).toEqual([]);
    const sql = readFileSync(new URL(`${FILE}.sql`, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    // The three widened rows are upserts; the migration never narrows or leaves one off.
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    expect(sql).not.toMatch(/DO NOTHING/i);
  });

  it('the country literal in 0034 equals the one ISO constant in @umsbx/contracts', () => {
    const sql = readFileSync(join(common, `${FILE}.sql`), 'utf8').replace(/--.*$/gm, '');
    const m = /world text\[\] := ARRAY\[([^\]]*)\]/.exec(sql);
    expect(m).not.toBeNull();
    const literal = [...m![1]!.matchAll(/'([A-Z]{2})'/g)].map((x) => x[1]!);
    expect(literal).toEqual([...ISO_3166_1_ALPHA2].filter((c) => c !== 'IN'));
    expect(literal).toEqual([...WORLDWIDE_PAYEE_COUNTRIES]);
    expect(literal).toHaveLength(248);
    // Written once: no second copy of the country list in the file.
    expect(sql.match(/ARRAY\['AD'/g) ?? []).toEqual([]);
    expect((sql.match(/'ZW'/g) ?? []).length).toBe(1);
  });
});

describe('migration 0034: the five rows', () => {
  it('a fresh database holds exactly the five corridors, each exactly as specified', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    await migrate(d, clock);
    const all = await rows(d);
    expect(all.map((r) => r.id)).toEqual([
      'de-eur',
      'gb-gbp',
      'in-eur',
      'in-gbp',
      'in-usd',
      'us-usd',
    ]);
    expect(byId(all, 'us-usd')).toEqual(wide('us-usd', 'USD'));
    expect(byId(all, 'gb-gbp')).toEqual(wide('gb-gbp', 'GBP'));
    expect(byId(all, 'de-eur')).toEqual(wide('de-eur', 'EUR'));
    expect(byId(all, 'in-eur')).toEqual(india('in-eur', 'EUR'));
    expect(byId(all, 'in-gbp')).toEqual(india('in-gbp', 'GBP'));
    expect(byId(all, 'in-usd')).toEqual(india('in-usd', 'USD'));
  });

  it('on a deployed database: narrow and off gb-gbp and de-eur become wide and on; an operator change on us-usd stays; ids and currencies unchanged', async () => {
    const { d, dir, cleanup } = await before0034();
    try {
      await insertNarrow(d, 'gb-gbp', 'GBP', ['GB'], ['GB']);
      await insertNarrow(d, 'de-eur', 'EUR', ['DE'], ['*']);
      await d.query(
        `UPDATE corridors SET min_charge_minor = 50, updated_at = $1 WHERE id = 'us-usd'`,
        [T],
      );
      const was = await rows(d);
      expect(was.map((r) => r.id)).toEqual(['de-eur', 'gb-gbp', 'in-usd', 'us-usd']);
      expect(byId(was, 'us-usd').payee_countries).toEqual(['US']);

      addFile(dir);
      expect(await applyMigrations(d, clock, dir)).toEqual([FILE]);
      const now = await rows(d);
      expect(now.map((r) => r.id)).toEqual([
        'de-eur',
        'gb-gbp',
        'in-eur',
        'in-gbp',
        'in-usd',
        'us-usd',
      ]);
      // Ids and currencies never change.
      for (const id of ['us-usd', 'gb-gbp', 'de-eur'])
        expect(byId(now, id).currency, id).toBe(byId(was, id).currency);
      expect(byId(now, 'gb-gbp')).toEqual({
        ...wide('gb-gbp', 'GBP'),
        created_at: new Date(T).toISOString(),
        updated_at: EPOCH,
      });
      expect(byId(now, 'de-eur')).toEqual({
        ...wide('de-eur', 'EUR'),
        created_at: new Date(T).toISOString(),
        updated_at: EPOCH,
      });
      // The operator's minimum charge on us-usd is a column 0034 does not own: kept.
      expect(byId(now, 'us-usd')).toEqual({
        ...wide('us-usd', 'USD'),
        min_charge_minor: 50,
        created_at: EPOCH,
        updated_at: EPOCH,
      });
      expect(byId(now, 'in-usd')).toEqual(byId(was, 'in-usd'));
      expect(byId(now, 'in-eur')).toEqual(india('in-eur', 'EUR'));
      expect(byId(now, 'in-gbp')).toEqual(india('in-gbp', 'GBP'));
      // A second pass applies nothing.
      expect(await applyMigrations(d, clock, dir)).toEqual([]);
      expect(await rows(d)).toEqual(now);
    } finally {
      cleanup();
    }
  });

  it('a deployed database where an operator switched us-usd off: 0034 switches it on (the owner rule)', async () => {
    const { d, dir, cleanup } = await before0034();
    try {
      await d.query(`UPDATE corridors SET enabled = false WHERE id = 'us-usd'`);
      addFile(dir);
      await applyMigrations(d, clock, dir);
      expect(byId(await rows(d), 'us-usd').enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('a database that already holds in-eur or in-gbp is refused (plain insert: a clash is a fault)', async () => {
    const { d, dir, cleanup } = await before0034();
    try {
      await d.query(
        `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
         VALUES ('in-eur', 'EUR', 2, ARRAY['*'], ARRAY['IN'], false, NULL, false, $1, $1)`,
        [T],
      );
      addFile(dir);
      await expect(applyMigrations(d, clock, dir)).rejects.toThrow();
      // The whole file rolled back: us-usd is still narrow.
      expect(byId(await rows(d), 'us-usd').payee_countries).toEqual(['US']);
    } finally {
      cleanup();
    }
  });
});
