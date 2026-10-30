// AGREE-1: migration 0015 (publisher agreements). One new append-only table, no defaults, nothing else
// changed. Forward-only. Run on in-memory SQL. Tolerates later migrations: it never checks an exact list.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-10-30T10:00:00Z';
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
const pub = (d: Db, id: string) =>
  d.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, 'P', 'US', 'active', $3, $3)`,
    [id, `slug-${id}`, T],
  );
const agr = (d: Db, id: string, publisher: string, version = 'v1', method = 'seeded_demo') =>
  d.query(
    `INSERT INTO publisher_agreements
       (id, publisher_id, terms_version, accepted_at, accepted_by_label, method, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Demo publisher contact', $5, $4, $4)`,
    [id, publisher, version, T, method],
  );

describe('migration 0015', () => {
  it('is applied once, after 0013, and has no down step', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0015_publisher_agreements');
    expect(first.indexOf('0015_publisher_agreements')).toBeGreaterThan(
      first.indexOf('0013_publisher_applicants'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0015_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0015_publisher_agreements.sql', dir), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('accepts a seeded_demo record, one per publisher and version, and refuses anything else', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await agr(d, 'agr_1', 'pub_a');
    await expect(agr(d, 'agr_2', 'pub_a')).rejects.toThrow();
    await agr(d, 'agr_3', 'pub_a', 'v2');
    await expect(agr(d, 'agr_4', 'pub_a', 'v3', 'click_through')).rejects.toThrow();
    await expect(agr(d, 'agr_5', 'pub_a', '')).rejects.toThrow();
    await expect(agr(d, 'agr_6', 'pub_missing')).rejects.toThrow();
  });

  it('is append-only: no update, delete or truncate', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await agr(d, 'agr_1', 'pub_a');
    await expect(d.query("UPDATE publisher_agreements SET terms_version = 'v9'")).rejects.toThrow();
    await expect(d.query('DELETE FROM publisher_agreements')).rejects.toThrow();
    await expect(d.query('TRUNCATE publisher_agreements')).rejects.toThrow();
  });
});
