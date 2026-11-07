// POB-LINKU: migration 0032, one verified PayPal address per publisher. Forward-only. A partial unique index on
// the normalized address where state = 'verified'. Safe on a database that already holds duplicates: a DO block
// counts them first and raises, naming the counts and never an address, so the deploy fails closed before any
// change (the file is one transaction, so nothing is left half done). Tolerates later migrations.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { MIGRATIONS_ROOT, applyMigrations, migrate, openDatabase } from './index';

const T = '2026-11-07T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
const INDEX = 'publisher_paypal_links_verified_email_key';
const FILE = '0032_paypal_link_verified_unique';
const common = join(MIGRATIONS_ROOT, 'common');

const publisher = (d: Db, id: string): Promise<unknown> =>
  d.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, $2, 'GB', 'active', $3, $3)`,
    [id, id.replace('pub_', 'slug-'), T],
  );
const link = (
  d: Db,
  id: string,
  email: string,
  state: 'requested' | 'verified',
): Promise<unknown> =>
  d.query(
    `INSERT INTO publisher_paypal_links (publisher_id, paypal_email, state, verified_by, verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [id, email, state, state === 'verified' ? 'opr_x' : null, state === 'verified' ? T : null, T],
  );
const hasIndex = async (d: Db): Promise<boolean> =>
  (await d.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [INDEX])).rows.length === 1;
const applied = async (d: Db): Promise<string[]> =>
  (
    await d.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
  ).rows.map((r) => r.version);

/** A database migrated up to, but not including, 0032: the state a deployed database is in. */
async function before0032(): Promise<{ d: Db; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'ums-mig32-'));
  for (const f of readdirSync(common).filter((n) => /^\d{4}_.+\.sql$/.test(n) && n < '0032'))
    cpSync(join(common, f), join(dir, f));
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await applyMigrations(d, clock, dir);
  return { d, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('migration 0032: applied once, forward only', () => {
  it('is applied once, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain(FILE);
    expect(first.indexOf(FILE)).toBeGreaterThan(first.indexOf('0030_web_import'));
    expect(await migrate(d, clock)).toEqual([]);
    expect(await hasIndex(d)).toBe(true);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((x) => /^0032_.*(down|rollback)/i.test(x))).toEqual([]);
    const sql = readFileSync(new URL(`${FILE}.sql`, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
  });

  it('applies on a database with data and no duplicate, changes no row, and then holds the rule', async () => {
    const { d, cleanup } = await before0032();
    try {
      for (const id of ['pub_a', 'pub_b', 'pub_c']) await publisher(d, id);
      await link(d, 'pub_a', 'a@example.com', 'verified');
      await link(d, 'pub_b', 'b@example.com', 'verified');
      // several requested links may share an address, and one may share it with a verified link
      await link(d, 'pub_c', 'a@example.com', 'requested');
      const rows = async () =>
        (await d.query('SELECT * FROM publisher_paypal_links ORDER BY publisher_id')).rows;
      const was = await rows();
      expect(await migrate(d, clock)).toContain(FILE);
      expect(await rows()).toEqual(was);
      expect(await hasIndex(d)).toBe(true);
      await expect(
        d.query(
          `UPDATE publisher_paypal_links SET state = 'verified', verified_by = 'o', verified_at = $2 WHERE publisher_id = $1`,
          ['pub_c', T],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      cleanup();
    }
  });

  it('refuses a database that already holds a shared verified address: the counts, no address, no change', async () => {
    const { d, cleanup } = await before0032();
    try {
      for (const id of ['pub_a', 'pub_b', 'pub_c', 'pub_d', 'pub_e']) await publisher(d, id);
      // the pre-state: two addresses each verified for two or more publishers (one pair differs only in case)
      await link(d, 'pub_a', 'dup.one@example.com', 'verified');
      await link(d, 'pub_b', 'dup.one@example.com', 'verified');
      await link(d, 'pub_c', 'dup.two@example.com', 'verified');
      await link(d, 'pub_d', 'DUP.TWO@example.com', 'verified');
      await link(d, 'pub_e', 'fine@example.com', 'verified');
      const was = (await d.query('SELECT * FROM publisher_paypal_links ORDER BY publisher_id'))
        .rows;
      const tables = async () =>
        (
          await d.query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
          )
        ).rows;
      const t0 = await tables();
      const v0 = await applied(d);
      let message = '';
      try {
        await migrate(d, clock);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/2 verified PayPal addresses/);
      expect(message).toMatch(/4 rows/);
      expect(message).not.toMatch(/dup\.|example\.com/i);
      expect(await hasIndex(d)).toBe(false);
      expect(await applied(d)).toEqual(v0);
      expect(await tables()).toEqual(t0);
      expect(
        (await d.query('SELECT * FROM publisher_paypal_links ORDER BY publisher_id')).rows,
      ).toEqual(was);
      // resolved by the owner (one of each pair goes back to requested): the migration then applies
      await d.query(
        `UPDATE publisher_paypal_links SET state = 'requested', verified_by = NULL, verified_at = NULL WHERE publisher_id IN ('pub_b', 'pub_d')`,
      );
      expect(await migrate(d, clock)).toContain(FILE);
      expect(await hasIndex(d)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
