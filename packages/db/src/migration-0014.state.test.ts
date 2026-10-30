// PUB-E1: migration 0014 (publisher_visits). One small table, forward only, no defaults, no delete of
// anything that exists. Applies on a copy that holds 0012 era rows and keeps every one of them.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { applyMigrations, migrate, openDatabase } from './index';

const T = '2026-10-30T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
const fresh = async (): Promise<Db> => {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
};
const addPublisher = (d: Db, id: string): Promise<unknown> =>
  d.query(
    `INSERT INTO publishers (id, slug, display_name, country, created_at, updated_at) VALUES ($1,$2,'P','US',$3,$3)`,
    [id, `slug-${id}`, T],
  );

describe('migration 0014', () => {
  it('applies after the earlier ones on a copy, keeps every old row, and a second run is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig13-'));
    try {
      const common = new URL('../migrations/common/', import.meta.url);
      for (const f of readdirSync(common).filter((n) => /^(000[1-9]|001[0-3])_.+\.sql$/.test(n))) {
        writeFileSync(join(dir, f), readFileSync(new URL(f, common), 'utf8'));
      }
      const d = await openDatabase({ kind: 'pglite-memory' });
      toClose.push(d);
      // The last file below 0014 is 0012, or 0013 once the applicants lane is on this branch.
      expect((await applyMigrations(d, clock, dir)).at(-1)).toMatch(/^001[23]_/);
      await addPublisher(d, 'pub_old');
      const before = (await d.query('SELECT * FROM publishers ORDER BY id')).rows;

      expect(await migrate(d, clock)).toEqual(['0014_publisher_visits']);

      expect((await d.query('SELECT * FROM publishers ORDER BY id')).rows).toEqual(before);
      expect((await d.query('SELECT * FROM publisher_visits')).rows).toEqual([]);
      expect(await migrate(d, clock)).toEqual([]);
      expect(readdirSync(common).filter((n) => /^0014_/.test(n))).toEqual([
        '0014_publisher_visits.sql',
      ]);
      expect(
        readdirSync(common).filter((n) => /^0014_.+\.sql$/.test(n) && /down|rollback/i.test(n)),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has the columns, no defaults, and one row per publisher', async () => {
    const d = await fresh();
    const cols = await d.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'publisher_visits' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => [r.column_name, r.is_nullable])).toEqual([
      ['created_at', 'NO'],
      ['last_seen_at', 'NO'],
      ['publisher_id', 'NO'],
      ['since_at', 'YES'],
      ['updated_at', 'NO'],
    ]);
    expect(cols.rows.every((r) => r.column_default === null)).toBe(true);
    await addPublisher(d, 'pub_a');
    const ins = (id: string) =>
      d.query(
        `INSERT INTO publisher_visits (publisher_id, since_at, last_seen_at, created_at, updated_at) VALUES ($1,NULL,$2,$2,$2)`,
        [id, T],
      );
    await ins('pub_a');
    await expect(ins('pub_a')).rejects.toThrow();
    await expect(ins('pub_unknown')).rejects.toThrow();
  });

  it('allows the one row to be updated (it is a cursor, not history)', async () => {
    const d = await fresh();
    await addPublisher(d, 'pub_b');
    await d.query(
      `INSERT INTO publisher_visits (publisher_id, since_at, last_seen_at, created_at, updated_at) VALUES ('pub_b',NULL,$1,$1,$1)`,
      [T],
    );
    await d.query(`UPDATE publisher_visits SET last_seen_at = $1 WHERE publisher_id = 'pub_b'`, [
      '2026-10-31T10:00:00Z',
    ]);
    expect(
      (
        await d.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM publisher_visits')
      ).rows[0]!.last_seen_at.toISOString(),
    ).toBe('2026-10-31T10:00:00.000Z');
  });
});
