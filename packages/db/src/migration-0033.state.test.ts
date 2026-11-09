// COR-IN: migration 0033, the India USD corridor (docs/specs/db-in-usd-corridor.md). Forward-only. One row into
// corridors: in-usd, USD, payee India, any buyer country, no domestic sale, switched on. Nothing else changes: the
// us-usd row is as it was, and a row another lane or an operator already holds is left alone (ON CONFLICT DO
// NOTHING). Tolerates later migrations: it never checks an exact list of files.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { MIGRATIONS_ROOT, applyMigrations, migrate, openDatabase } from './index';

const T = '2026-11-09T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
const FILE = '0033_in_usd_corridor';
const common = join(MIGRATIONS_ROOT, 'common');

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
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  }));
const byId = (all: Row[], id: string): Row => {
  const r = all.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no corridor ${id}`);
  return r;
};

const EPOCH = '1970-01-01T00:00:00.000Z';
const IN_USD: Row = {
  id: 'in-usd',
  currency: 'USD',
  minor_units: 2,
  buyer_countries: ['*'],
  payee_countries: ['IN'],
  domestic_supported: false,
  min_charge_minor: null,
  enabled: true,
  created_at: EPOCH,
  updated_at: EPOCH,
};

/** A database migrated up to, but not including, 0033: the state a deployed database is in. */
async function before0033(): Promise<{ d: Db; dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'ums-mig33-'));
  for (const f of readdirSync(common).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0033'))
    cpSync(join(common, f), join(dir, f));
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await applyMigrations(d, clock, dir);
  return { d, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const addFile = (dir: string): void =>
  cpSync(join(common, `${FILE}.sql`), join(dir, `${FILE}.sql`));

describe('migration 0033: applied once, forward only', () => {
  it('is applied once, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain(FILE);
    expect(first.indexOf(FILE)).toBeGreaterThan(first.indexOf('0032_paypal_link_verified_unique'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((x) => /^0033_.*(down|rollback)/i.test(x))).toEqual([]);
    const sql = readFileSync(new URL(`${FILE}.sql`, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });
});

describe('migration 0033: the in-usd row', () => {
  it('a fresh database holds exactly us-usd and in-usd, and in-usd is exactly the specified row', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    await migrate(d, clock);
    const all = await rows(d);
    expect(all.map((r) => r.id)).toEqual(['in-usd', 'us-usd']);
    expect(byId(all, 'in-usd')).toEqual(IN_USD);
  });

  it('adds one row to a deployed database and leaves every other corridor row exactly as it was', async () => {
    const { d, dir, cleanup } = await before0033();
    try {
      // The seed adds gb-gbp and de-eur (both off) to a deployed database; an operator may have changed a row.
      for (const [id, cur, cc] of [
        ['gb-gbp', 'GBP', 'GB'],
        ['de-eur', 'EUR', 'DE'],
      ] as const)
        await d.query(
          `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
           VALUES ($1, $2, 2, $3, $4, true, NULL, false, $5, $5)`,
          [id, cur, id === 'gb-gbp' ? ['GB'] : ['*'], [cc], T],
        );
      await d.query(
        `UPDATE corridors SET min_charge_minor = 50, updated_at = $1 WHERE id = 'us-usd'`,
        [T],
      );
      const was = await rows(d);
      expect(was.map((r) => r.id)).toEqual(['de-eur', 'gb-gbp', 'us-usd']);

      addFile(dir);
      expect(await applyMigrations(d, clock, dir)).toEqual([FILE]);
      const now = await rows(d);
      expect(now.map((r) => r.id)).toEqual(['de-eur', 'gb-gbp', 'in-usd', 'us-usd']);
      expect(byId(now, 'in-usd')).toEqual(IN_USD);
      for (const id of ['de-eur', 'gb-gbp', 'us-usd'])
        expect(byId(now, id), id).toEqual(byId(was, id));
      expect(byId(now, 'us-usd').enabled).toBe(true);
      expect(byId(now, 'gb-gbp').enabled).toBe(false);
      expect(byId(now, 'de-eur').enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('us-usd is the same row after the migration as in 0001 (US, US, domestic, on)', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    await migrate(d, clock);
    expect(byId(await rows(d), 'us-usd')).toEqual({
      id: 'us-usd',
      currency: 'USD',
      minor_units: 2,
      buyer_countries: ['US'],
      payee_countries: ['US'],
      domestic_supported: true,
      min_charge_minor: null,
      enabled: true,
      created_at: EPOCH,
      updated_at: EPOCH,
    });
  });

  it('a database that already holds an in-usd row keeps it as it is (ON CONFLICT DO NOTHING)', async () => {
    const { d, dir, cleanup } = await before0033();
    try {
      await d.query(
        `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
         VALUES ('in-usd', 'USD', 2, ARRAY['IN'], ARRAY['IN'], false, NULL, false, $1, $1)`,
        [T],
      );
      addFile(dir);
      expect(await applyMigrations(d, clock, dir)).toEqual([FILE]);
      const r = byId(await rows(d), 'in-usd');
      expect(r).toMatchObject({
        buyer_countries: ['IN'],
        enabled: false,
        created_at: new Date(T).toISOString(),
      });
    } finally {
      cleanup();
    }
  });
});
