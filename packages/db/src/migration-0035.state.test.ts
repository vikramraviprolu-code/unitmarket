// WEB-IMPORT-SW: migration 0035 adds the web_import_enabled switch, OFF at seed (docs/specs/web-import-switch.md).
// Forward only. The runner applies every unapplied file in name order with no contiguity check, so 0035 applies
// on a database that has not applied 0034 (lane L3 owns 0034). Tolerates later migrations: it never checks an
// exact list of files.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const FILE = '0035_web_import_switch';
const common = join(MIGRATIONS_ROOT, 'common');
const fresh = async (): Promise<Db> => {
  const d = (await openDatabase({ kind: 'pglite-memory' })) as Db;
  toClose.push(d);
  return d;
};
const switches = async (d: Db): Promise<Record<string, boolean>> =>
  Object.fromEntries(
    (
      await d.query<{ name: string; on: boolean }>(
        'SELECT name, "on" FROM safety_switches ORDER BY name',
      )
    ).rows.map((r) => [r.name, r.on]),
  );

describe('migration 0035: applied once, forward only', () => {
  it('is applied once, with no down step, no default and no now()', async () => {
    const d = await fresh();
    const first = await migrate(d, clock);
    expect(first).toContain(FILE);
    expect(first.indexOf(FILE)).toBeGreaterThan(first.indexOf('0033_in_usd_corridor'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((x) => /^0035_.*(down|rollback)/i.test(x))).toEqual([]);
    const sql = readFileSync(new URL(`${FILE}.sql`, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
  });
});

describe('migration 0035: the web_import_enabled switch', () => {
  it('exists, is OFF, is seeded at the epoch by seed, and the other seven keep their values', async () => {
    const d = await fresh();
    await migrate(d, clock);
    const row = (
      await d.query<{ on: boolean; changed_by: string; changed_at: string; reason: string }>(
        `SELECT "on", changed_by, changed_at, reason FROM safety_switches WHERE name = 'web_import_enabled'`,
      )
    ).rows[0]!;
    expect(row.on).toBe(false);
    expect(row.changed_by).toBe('seed');
    expect(new Date(row.changed_at).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(row.reason).toMatch(/^seed/);
    expect(await switches(d)).toEqual({
      agent_buy_enabled: false,
      ai_enabled: true,
      checkout_enabled: true,
      paypal_outbound: false,
      refunds_enabled: true,
      unlock_enabled: true,
      web_import_enabled: false,
      webhook_enabled: true,
    });
  });

  it('the name list is widened by one and stays closed: another name and a delete are still refused', async () => {
    const d = await fresh();
    await migrate(d, clock);
    await expect(
      d.query(
        `INSERT INTO safety_switches (name, "on", changed_by, changed_at, reason, created_at, updated_at) VALUES ('live', true, 'x', now(), 'x', now(), now())`,
      ),
    ).rejects.toThrow();
    await expect(
      d.query(`DELETE FROM safety_switches WHERE name = 'web_import_enabled'`),
    ).rejects.toThrow();
    // an operator can still turn it on and off like the other switches
    await d.query(`UPDATE safety_switches SET "on" = true WHERE name = 'web_import_enabled'`);
    expect((await switches(d)).web_import_enabled).toBe(true);
  });

  it('applies on a database that has not applied 0034 (names only the files before 0034 and 0035 exist)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig35-'));
    try {
      for (const f of readdirSync(common).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0034'))
        cpSync(join(common, f), join(dir, f));
      cpSync(join(common, `${FILE}.sql`), join(dir, `${FILE}.sql`));
      const d = await fresh();
      const applied = await applyMigrations(d, clock, dir);
      expect(applied[applied.length - 1]).toBe(FILE);
      expect(applied).not.toContain('0034_ww_corridors');
      expect((await switches(d)).web_import_enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a database that already ran 0035 and later gets an older-numbered file still applies it (name order, no checksum)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig35b-'));
    try {
      for (const f of readdirSync(common).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0034'))
        cpSync(join(common, f), join(dir, f));
      cpSync(join(common, `${FILE}.sql`), join(dir, `${FILE}.sql`));
      const d = await fresh();
      await applyMigrations(d, clock, dir);
      // a stand-in for 0034 arrives afterwards: it is applied, and 0035's row is untouched
      await d.exec(`UPDATE safety_switches SET "on" = true WHERE name = 'web_import_enabled'`);
      writeFileSync(
        join(dir, '0034_stand_in.sql'),
        'CREATE TABLE stand_in_0034 (id text PRIMARY KEY);\n',
      );
      expect(await applyMigrations(d, clock, dir)).toEqual(['0034_stand_in']);
      expect((await switches(d)).web_import_enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
