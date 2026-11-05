// POB-P1: claim and sign in of a publisher account on the real schema (PGlite plus the common migrations).
// An invite makes one account; sign in is the buyer scheme (scrypt, one verification, a lock after 20 misses)
// and needs an active publisher. Nothing here writes a password or a code to the audit sink or the log.
import { describe, expect, it } from 'vitest';
import { ACCOUNT_LOCK_BASE_MS, ACCOUNT_LOCK_THRESHOLD } from './accounts';
import { claimPublisherAccount, hashInviteCode, verifyPublisherLogin } from './publisher-accounts';
import { makeRig as baseRig, seededIds } from './test-support';
import type { TestRig } from './test-support';

let rigs = 0;
const makeRig = () => {
  rigs += 1;
  return baseRig({ ids: seededIds(`pubacct-${String(rigs)}`) });
};
const PW = 'violet lamps hum softly';
const DAY = 86_400_000;
let n = 0;
const rows = async <T>(r: TestRig, sql: string, p: unknown[] = []): Promise<T[]> =>
  (await r.db.query<T>(sql, p)).rows;

/** An active publisher and a live invite. Returns the id and the clear code (the test is the operator). */
async function world(r: TestRig, o: { status?: string; code?: string; ttl?: number } = {}) {
  n += 1;
  const id = `pub_acct${String(n)}`;
  const code = o.code ?? `ACCT${String(n).padStart(8, '0')}`;
  const at = r.clock.now().toISOString();
  await r.db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'GB', $4, $5, $5)`,
    [id, `acct-pub-${String(n)}`, `Acct Pub ${String(n)}`, o.status ?? 'active', at],
  );
  await r.db.query(
    `INSERT INTO publisher_invites (id, publisher_id, code_hash, expires_at, used_at, voided_at, created_by, created_at)
     VALUES ($1, $2, $3, $4, NULL, NULL, 'opr_vikram', $5)`,
    [
      `aud_inv${String(n)}`,
      id,
      hashInviteCode(code),
      new Date(r.clock.now().getTime() + (o.ttl ?? 7 * DAY)).toISOString(),
      at,
    ],
  );
  return { id, code, username: `owner.${String(n)}` };
}
const claim = (r: TestRig, w: { code: string; username: string }, o: Record<string, string> = {}) =>
  claimPublisherAccount(r.deps, {
    code: w.code,
    username: w.username,
    password: PW,
    ip_hash: 'iphash-a',
    ...o,
  });

describe('claimPublisherAccount', () => {
  it('makes the account, marks the invite used, and audits claimed without the code or the password', async () => {
    const r = await makeRig();
    const w = await world(r);
    const res = await claim(r, w);
    expect(res).toEqual({ ok: true, publisher_id: w.id });
    const acct = await rows<Record<string, unknown>>(
      r,
      'SELECT * FROM publisher_accounts WHERE publisher_id = $1',
      [w.id],
    );
    expect(acct).toHaveLength(1);
    expect(acct[0]).toMatchObject({ username: w.username, failed_attempts: 0, locked_until: null });
    expect(String(acct[0]!['password_hash'])).toMatch(
      /^scrypt:16384:8:1:[0-9a-f]{32,}:[0-9a-f]{64}$/,
    );
    const inv = await rows<{ used_at: unknown }>(
      r,
      'SELECT used_at FROM publisher_invites WHERE publisher_id = $1',
      [w.id],
    );
    expect(inv[0]!.used_at).not.toBeNull();
    const claimed = r.audit.filter((e) => e.action === 'publisher_account.claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      actor: { kind: 'publisher', publisher_id: w.id },
      target: w.id,
    });
    const everything = JSON.stringify([r.audit, r.log.events, acct]);
    expect(everything).not.toContain(PW);
    expect(everything).not.toContain(w.code);
  });

  it('accepts the code in lower case with hyphens, once only', async () => {
    const r = await makeRig();
    const w = await world(r, { code: 'ABCDEFGHJKMN' });
    expect((await claim(r, { ...w, code: 'abcd-efgh-jkmn' })).ok).toBe(true);
    const again = await claim(r, { ...w, username: 'second.try', code: 'ABCDEFGHJKMN' });
    expect(again).toEqual({ ok: false, code: 'invalid_code' });
  });

  it('a taken username refuses the claim and leaves the invite unused', async () => {
    const r = await makeRig();
    const a = await world(r);
    const b = await world(r);
    expect((await claim(r, a)).ok).toBe(true);
    expect(await claim(r, { code: b.code, username: a.username })).toEqual({
      ok: false,
      code: 'taken',
    });
    expect(
      await rows(r, 'SELECT 1 FROM publisher_accounts WHERE publisher_id = $1', [b.id]),
    ).toEqual([]);
    expect((await claim(r, b)).ok).toBe(true);
  });

  it('a suspended or applied publisher cannot claim; the answer is the generic one', async () => {
    const r = await makeRig();
    for (const status of ['suspended', 'applied']) {
      const w = await world(r, { status });
      expect(await claim(r, w), status).toEqual({ ok: false, code: 'invalid_code' });
    }
  });

  it('refuses weak passwords and bad shapes before it spends a try or touches the invite', async () => {
    const r = await makeRig();
    const w = await world(r);
    expect(await claim(r, w, { password: 'short' })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'too_short',
    });
    expect(await claim(r, { ...w, username: 'Bad Name' })).toEqual({
      ok: false,
      code: 'invalid_input',
    });
    expect(await claim(r, { ...w, code: 'nope' })).toEqual({ ok: false, code: 'invalid_input' });
    expect(await rows(r, 'SELECT 1 FROM rate_buckets')).toEqual([]);
    expect((await claim(r, w)).ok).toBe(true);
  });
});

describe('verifyPublisherLogin', () => {
  it('signs in the claimed account, resets the failure count, audits the login', async () => {
    const r = await makeRig();
    const w = await world(r);
    await claim(r, w);
    await verifyPublisherLogin(r.deps, { username: w.username, password: 'wrong wrong wrong' });
    expect(
      (
        await rows<{ failed_attempts: number }>(
          r,
          'SELECT failed_attempts FROM publisher_accounts WHERE publisher_id = $1',
          [w.id],
        )
      )[0]!.failed_attempts,
    ).toBe(1);
    expect(await verifyPublisherLogin(r.deps, { username: w.username, password: PW })).toEqual({
      ok: true,
      publisher_id: w.id,
    });
    expect(
      (
        await rows<{ failed_attempts: number }>(
          r,
          'SELECT failed_attempts FROM publisher_accounts WHERE publisher_id = $1',
          [w.id],
        )
      )[0]!.failed_attempts,
    ).toBe(0);
    expect(r.audit.some((e) => e.action === 'publisher_account.login')).toBe(true);
    expect(JSON.stringify([r.audit, r.log.events])).not.toContain(PW);
  });

  it('answers the same for an unknown name and a wrong password', async () => {
    const r = await makeRig();
    const w = await world(r);
    await claim(r, w);
    expect(await verifyPublisherLogin(r.deps, { username: 'nobody.here', password: PW })).toEqual({
      ok: false,
    });
    expect(
      await verifyPublisherLogin(r.deps, { username: w.username, password: 'wrong wrong wrong' }),
    ).toEqual({ ok: false });
    expect(
      await verifyPublisherLogin(r.deps, {
        username: "x'; DROP TABLE publishers;--",
        password: PW,
      }),
    ).toEqual({ ok: false });
  });

  it('locks after 20 misses for 15 minutes and the right password then fails until the lock ends', async () => {
    const r = await makeRig();
    const w = await world(r);
    await claim(r, w);
    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i++)
      await verifyPublisherLogin(r.deps, { username: w.username, password: 'wrong wrong wrong' });
    expect(await verifyPublisherLogin(r.deps, { username: w.username, password: PW })).toEqual({
      ok: false,
    });
    expect(r.audit.some((e) => e.action === 'publisher_account.locked')).toBe(true);
    r.clock.advance(ACCOUNT_LOCK_BASE_MS + 1000);
    expect((await verifyPublisherLogin(r.deps, { username: w.username, password: PW })).ok).toBe(
      true,
    );
  });

  it('needs an active publisher: the right password for a suspended one fails the same way and counts nothing', async () => {
    const r = await makeRig();
    const w = await world(r);
    await claim(r, w);
    await r.db.query("UPDATE publishers SET status = 'suspended' WHERE id = $1", [w.id]);
    expect(await verifyPublisherLogin(r.deps, { username: w.username, password: PW })).toEqual({
      ok: false,
    });
    expect(
      (
        await rows<{ failed_attempts: number }>(
          r,
          'SELECT failed_attempts FROM publisher_accounts WHERE publisher_id = $1',
          [w.id],
        )
      )[0]!.failed_attempts,
    ).toBe(0);
    await r.db.query("UPDATE publishers SET status = 'active' WHERE id = $1", [w.id]);
    expect((await verifyPublisherLogin(r.deps, { username: w.username, password: PW })).ok).toBe(
      true,
    );
  });

  it('a buyer account name does not sign in as a publisher', async () => {
    const r = await makeRig();
    expect(await verifyPublisherLogin(r.deps, { username: 'user.1', password: PW })).toEqual({
      ok: false,
    });
  });
});
