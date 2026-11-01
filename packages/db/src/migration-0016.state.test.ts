// ID-ACCOUNTS: migration 0016 (buyer accounts). One new table, no defaults, forward-only, nothing else
// changed. System only: the Supabase policy is a listed follow-up (Supabase is unused, D-049). Run on
// in-memory SQL (and on real Postgres when UMS_TEST_DB=postgres). Tolerates later migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-10-31T10:00:00Z';
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
const buyer = (d: Db, id: string) =>
  d.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ($1, 'B', $2, 'GB', $3, $3)`,
    [id, `account:${id}`, T],
  );
const HASH = 'scrypt:16384:8:1:00112233445566778899aabbccddeeff:' + 'a'.repeat(64);
const acct = (
  d: Db,
  buyer_id: string,
  username: string,
  over: { failed?: number; locked?: string | null; hash?: string | null } = {},
) =>
  d.query(
    `INSERT INTO buyer_accounts
       (buyer_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
    [
      buyer_id,
      username,
      over.hash === undefined ? HASH : over.hash,
      over.failed ?? 0,
      over.locked ?? null,
      T,
    ],
  );

describe('migration 0016', () => {
  it('is applied once, after 0015, and has no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0016_buyer_accounts');
    expect(first.indexOf('0016_buyer_accounts')).toBeGreaterThan(
      first.indexOf('0015_publisher_agreements'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0016_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0016_buyer_accounts.sql', dir), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('has the columns of the spec and no email column of any kind', async () => {
    const d = await fresh();
    const cols = await d.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'buyer_accounts' ORDER BY column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'buyer_id',
      'created_at',
      'failed_attempts',
      'locked_until',
      'password_changed_at',
      'password_hash',
      'updated_at',
      'username',
    ]);
    expect(cols.rows.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name)).toEqual([
      'locked_until',
    ]);
  });

  it('stores one account per buyer, a unique username, and refuses a username of the wrong shape', async () => {
    const d = await fresh();
    await buyer(d, 'buy_a');
    await buyer(d, 'buy_b');
    await buyer(d, 'buy_c');
    await acct(d, 'buy_a', 'alice.x');
    await expect(acct(d, 'buy_a', 'alice.y')).rejects.toThrow();
    await expect(acct(d, 'buy_b', 'alice.x')).rejects.toThrow();
    for (const bad of [
      'ab',
      'x'.repeat(31),
      'Alice',
      'a b',
      'a@b.c',
      "o'neil",
      '',
      'ü'.repeat(3),
    ]) {
      await expect(acct(d, 'buy_c', bad), bad).rejects.toThrow();
    }
    await acct(d, 'buy_b', 'a'.repeat(30));
  });

  it('needs a real buyer, a hash and a non-negative count', async () => {
    const d = await fresh();
    await buyer(d, 'buy_a');
    await expect(acct(d, 'buy_missing', 'ghost.1')).rejects.toThrow();
    await expect(acct(d, 'buy_a', 'alice.x', { hash: null })).rejects.toThrow();
    await expect(acct(d, 'buy_a', 'alice.x', { hash: '' })).rejects.toThrow();
    await expect(acct(d, 'buy_a', 'alice.x', { failed: -1 })).rejects.toThrow();
    await acct(d, 'buy_a', 'alice.x', { failed: 3, locked: T });
  });

  it('can be updated (counts, lock, hash) because sign-in state lives here', async () => {
    const d = await fresh();
    await buyer(d, 'buy_a');
    await acct(d, 'buy_a', 'alice.x');
    await d.query(
      "UPDATE buyer_accounts SET failed_attempts = 5, locked_until = $1 WHERE buyer_id = 'buy_a'",
      [T],
    );
    expect((await d.query('SELECT failed_attempts FROM buyer_accounts')).rows).toEqual([
      { failed_attempts: 5 },
    ]);
  });

  it('leaves buyers alone: a persona buyer needs no account', async () => {
    const d = await fresh();
    await buyer(d, 'buy_persona');
    expect(
      Number((await d.query<{ c: string }>('SELECT count(*) AS c FROM buyer_accounts')).rows[0]!.c),
    ).toBe(0);
  });
});
