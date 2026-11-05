// POB-P1: migration 0028 (publisher accounts). Three new tables (publisher_accounts, publisher_invites,
// publisher_paypal_links), no defaults, forward-only, and one widened CHECK: the agreement method may now be
// publisher_accepted. Run on in-memory SQL. Tolerates later migrations: it never checks an exact list.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

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
const pub = (d: Db, id: string) =>
  d.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, 'P', 'US', 'active', $3, $3)`,
    [id, `slug-${id}`, T],
  );
const HASH = 'scrypt:16384:8:1:00112233445566778899aabbccddeeff:' + 'a'.repeat(64);
const acct = (d: Db, publisher_id: string, username: string, hash = HASH) =>
  d.query(
    `INSERT INTO publisher_accounts
       (publisher_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 0, NULL, $4, $4, $4)`,
    [publisher_id, username, hash, T],
  );
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const invite = (
  d: Db,
  id: string,
  publisher_id: string,
  code_hash: string,
  o: { used?: string | null; voided?: string | null } = {},
) =>
  d.query(
    `INSERT INTO publisher_invites
       (id, publisher_id, code_hash, expires_at, used_at, voided_at, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'opr_vikram', $7)`,
    [id, publisher_id, code_hash, '2026-11-12T10:00:00Z', o.used ?? null, o.voided ?? null, T],
  );
const link = (
  d: Db,
  publisher_id: string,
  o: { state?: string; by?: string | null; at?: string | null; email?: string } = {},
) =>
  d.query(
    `INSERT INTO publisher_paypal_links
       (publisher_id, paypal_email, state, verified_by, verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      publisher_id,
      o.email ?? 'seller@example.com',
      o.state ?? 'requested',
      o.by === undefined ? null : o.by,
      o.at === undefined ? null : o.at,
      T,
    ],
  );
const agr = (d: Db, id: string, publisher: string, method: string, version = 'v1') =>
  d.query(
    `INSERT INTO publisher_agreements
       (id, publisher_id, terms_version, accepted_at, accepted_by_label, method, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'a.label', $5, $4, $4)`,
    [id, publisher, version, T, method],
  );

describe('migration 0028', () => {
  it('is applied once, after 0027, and has no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0028_publisher_accounts');
    expect(first.indexOf('0028_publisher_accounts')).toBeGreaterThan(
      first.indexOf('0027_rule_settings'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0028_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL('0028_publisher_accounts.sql', dir), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('publisher_accounts: one per publisher, a unique username of the buyer pattern, a real hash', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await pub(d, 'pub_b');
    await acct(d, 'pub_a', 'reader.one');
    await expect(acct(d, 'pub_a', 'reader.two')).rejects.toThrow();
    await expect(acct(d, 'pub_b', 'reader.one')).rejects.toThrow();
    for (const bad of ['ab', 'UPPER', 'has space', 'x'.repeat(31), 'a@b.c'])
      await expect(acct(d, 'pub_b', bad), bad).rejects.toThrow();
    await expect(acct(d, 'pub_b', 'reader.three', '')).rejects.toThrow();
    await expect(acct(d, 'pub_missing', 'reader.four')).rejects.toThrow();
    await acct(d, 'pub_b', 'reader.five');
    const cols = (
      await d.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'publisher_accounts' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toEqual(
      [
        'created_at',
        'failed_attempts',
        'locked_until',
        'password_changed_at',
        'password_hash',
        'publisher_id',
        'updated_at',
        'username',
      ].sort(),
    );
    // the failure count cannot go below zero
    await expect(
      d.query('UPDATE publisher_accounts SET failed_attempts = -1 WHERE publisher_id = $1', [
        'pub_a',
      ]),
    ).rejects.toThrow();
  });

  it('publisher_invites: only a hash is stored, one live invite per publisher, used or voided ones do not count', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await pub(d, 'pub_b');
    await invite(d, 'aud_1', 'pub_a', H1);
    // a second live invite for the same publisher is refused
    await expect(invite(d, 'aud_2', 'pub_a', H2)).rejects.toThrow();
    // the same code hash cannot be stored twice
    await expect(invite(d, 'aud_3', 'pub_b', H1)).rejects.toThrow();
    // a used or a voided invite frees the slot
    await d.query('UPDATE publisher_invites SET voided_at = $2 WHERE id = $1', ['aud_1', T]);
    await invite(d, 'aud_4', 'pub_a', H2);
    await d.query('UPDATE publisher_invites SET used_at = $2 WHERE id = $1', ['aud_4', T]);
    await invite(d, 'aud_5', 'pub_a', '3'.repeat(64));
    // not a SHA-256 hex string: refused (a clear text code can never be stored)
    for (const bad of ['ABCD2345WXYZ', 'g'.repeat(64), 'a'.repeat(63)])
      await expect(invite(d, 'aud_6', 'pub_b', bad), bad).rejects.toThrow();
    await expect(invite(d, 'aud_7', 'pub_missing', '4'.repeat(64))).rejects.toThrow();
    const cols = (
      await d.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'publisher_invites' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toEqual(
      [
        'code_hash',
        'created_at',
        'created_by',
        'expires_at',
        'id',
        'publisher_id',
        'used_at',
        'voided_at',
      ].sort(),
    );
  });

  it('publisher_paypal_links: requested or verified, and verified exactly when both verifier and time are set', async () => {
    const d = await fresh();
    for (const p of ['pub_a', 'pub_b', 'pub_c', 'pub_d', 'pub_e', 'pub_f']) await pub(d, p);
    await link(d, 'pub_a');
    await expect(link(d, 'pub_a')).rejects.toThrow(); // one row per publisher
    await link(d, 'pub_b', { state: 'verified', by: 'opr_vikram', at: T });
    // verified without a verifier, or without a time, or requested with either: refused
    await expect(link(d, 'pub_c', { state: 'verified' })).rejects.toThrow();
    await expect(link(d, 'pub_c', { state: 'verified', by: 'opr_vikram' })).rejects.toThrow();
    await expect(link(d, 'pub_c', { state: 'verified', at: T })).rejects.toThrow();
    await expect(
      link(d, 'pub_d', { state: 'requested', by: 'opr_vikram', at: T }),
    ).rejects.toThrow();
    await expect(link(d, 'pub_d', { state: 'requested', by: 'opr_vikram' })).rejects.toThrow();
    await expect(link(d, 'pub_d', { state: 'requested', at: T })).rejects.toThrow();
    await expect(link(d, 'pub_e', { state: 'approved' })).rejects.toThrow();
    await expect(link(d, 'pub_f', { email: '' })).rejects.toThrow();
    // a verified row going back to requested must clear both, in one statement
    await expect(
      d.query(`UPDATE publisher_paypal_links SET state = 'requested' WHERE publisher_id = 'pub_b'`),
    ).rejects.toThrow();
    await d.query(
      `UPDATE publisher_paypal_links SET state = 'requested', verified_by = NULL, verified_at = NULL WHERE publisher_id = 'pub_b'`,
    );
  });

  it('allows the agreement method publisher_accepted, keeps seeded_demo, refuses others, stays append-only', async () => {
    const d = await fresh();
    await pub(d, 'pub_a');
    await agr(d, 'agr_1', 'pub_a', 'seeded_demo');
    await agr(d, 'agr_2', 'pub_a', 'publisher_accepted', 'v2');
    await expect(agr(d, 'agr_3', 'pub_a', 'click_through', 'v3')).rejects.toThrow();
    await expect(agr(d, 'agr_4', 'pub_a', 'publisher_accepted', 'v2')).rejects.toThrow();
    await expect(d.query("UPDATE publisher_agreements SET terms_version = 'v9'")).rejects.toThrow();
    await expect(d.query('DELETE FROM publisher_agreements')).rejects.toThrow();
  });
});
