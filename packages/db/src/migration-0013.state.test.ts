// PUB-E2: migration 0013 (publisher applicants). One new append-only decision table, one decision per
// publisher, no defaults, nothing else changed. Forward-only. Run on in-memory SQL.
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
const pub = (d: Db, id: string, status = 'applied') =>
  d.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $1, 'P', 'US', $2, $3, $3)`,
    [id, status, T],
  );
const dec = (d: Db, id: string, publisher: string, decision: string) =>
  d.query(
    `INSERT INTO publisher_applicant_decisions (id, publisher_id, decision, operator_id, reason, created_at, updated_at)
     VALUES ($1, $2, $3, 'opr_v', 'because', $4, $4)`,
    [id, publisher, decision, T],
  );

describe('migration 0013', () => {
  it('is applied after 0012, once, and has no down step', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0013_publisher_applicants');
    expect(first.indexOf('0013_publisher_applicants')).toBeGreaterThan(
      first.indexOf('0012_publisher_side'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0013_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0013_publisher_applicants.sql', dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('accepts approved and rejected, one per publisher, and refuses anything else', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await pub(d, 'pub_b');
    await dec(d, 'aud_1', 'pub_a', 'rejected');
    await expect(dec(d, 'aud_2', 'pub_a', 'approved')).rejects.toThrow();
    await expect(dec(d, 'aud_3', 'pub_b', 'maybe')).rejects.toThrow();
    await expect(dec(d, 'aud_4', 'pub_missing', 'approved')).rejects.toThrow();
    await dec(d, 'aud_5', 'pub_b', 'approved');
  });

  it('is append-only: no update, delete or truncate', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await dec(d, 'aud_1', 'pub_a', 'approved');
    await expect(d.query("UPDATE publisher_applicant_decisions SET reason = 'x'")).rejects.toThrow();
    await expect(d.query('DELETE FROM publisher_applicant_decisions')).rejects.toThrow();
    await expect(d.query('TRUNCATE publisher_applicant_decisions')).rejects.toThrow();
  });

  it('leaves the publishers CHECK as 0012 made it (no rejected status)', async () => {
    const d = await fresh();
    await expect(pub(d, 'pub_x', 'rejected')).rejects.toThrow();
    await pub(d, 'pub_y', 'applied');
    await pub(d, 'pub_z', 'suspended');
  });
});
