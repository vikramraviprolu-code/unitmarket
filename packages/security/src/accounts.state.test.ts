// ID-ACCOUNTS: buyer accounts on the real schema (PGlite plus the common migrations, including 0016).
// Signup writes a buyer, an account, two consents and one audit row; login costs the same for an unknown name
// and a wrong password; five failures lock the account (15 minutes, doubling to one hour); a change of
// password ends the other sessions; the operator reset ends all of them. Time is the injected clock.
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_LOCK_BASE_MS,
  ACCOUNT_LOCK_CAP_MS,
  ACCOUNT_LOCK_THRESHOLD,
  changePassword,
  createAccount,
  resetPasswordForOperator,
  revokeBuyerSessions,
  verifyAccountLogin,
} from './accounts';
import { createSession, resolveSession } from './session';
import { cookiePair, makeRig } from './test-support';
import type { TestRig } from './test-support';

const MIN = 60_000;
const PASSWORD = 'violet lamps hum softly';
const NEW_PASSWORD = 'seven quiet harbours';
let n = 0;
const uname = (): string => {
  n += 1;
  return `user.${String(n)}`;
};
const input = (o: Record<string, string> = {}) => ({
  display_name: 'Test Reader',
  username: uname(),
  country: 'GB',
  password: PASSWORD,
  consent_version: 'terms-v1',
  ...o,
});
const rows = async <T>(r: TestRig, sql: string, p: unknown[] = []): Promise<T[]> =>
  (await r.db.query<T>(sql, p)).rows;

async function open(r: TestRig, o: Record<string, string> = {}) {
  const i = input(o);
  const res = await createAccount(r.deps, i);
  if (!res.ok) throw new Error(`signup failed: ${res.code}`);
  return { ...i, buyer_id: res.buyer_id };
}

describe('createAccount', () => {
  it('writes the buyer, the account, two consents and one audit row, and never the password', async () => {
    const r = await makeRig();
    const a = await open(r);
    expect(a.buyer_id).toMatch(/^buy_[0-9a-z]{26}$/);
    const buyer = await rows<{ auth_subject: string; display_name: string; country: string }>(
      r,
      'SELECT auth_subject, display_name, country FROM buyers WHERE id = $1',
      [a.buyer_id],
    );
    expect(buyer).toEqual([
      { auth_subject: `account:${a.username}`, display_name: 'Test Reader', country: 'GB' },
    ]);
    const acct = await rows<Record<string, unknown>>(
      r,
      'SELECT * FROM buyer_accounts WHERE buyer_id = $1',
      [a.buyer_id],
    );
    expect(acct).toHaveLength(1);
    expect(acct[0]).toMatchObject({ username: a.username, failed_attempts: 0, locked_until: null });
    expect(String(acct[0]!['password_hash'])).toMatch(/^scrypt:16384:8:1:[0-9a-f]{32,}:[0-9a-f]{64}$/);
    expect(JSON.stringify(acct)).not.toContain(PASSWORD);
    const consents = await rows<{ kind: string; text_version: string; revoked_at: unknown }>(
      r,
      'SELECT kind, text_version, revoked_at FROM consents WHERE buyer_id = $1 ORDER BY kind',
      [a.buyer_id],
    );
    expect(consents).toEqual([
      { kind: 'privacy', text_version: 'terms-v1', revoked_at: null },
      { kind: 'terms', text_version: 'terms-v1', revoked_at: null },
    ]);
    const signups = r.audit.filter((e) => e.action === 'account.signup');
    expect(signups).toHaveLength(1);
    expect(signups[0]).toMatchObject({ actor: { kind: 'buyer', buyer_id: a.buyer_id }, target: a.buyer_id });
    expect(JSON.stringify(r.audit)).not.toContain(PASSWORD);
  });

  it('keeps usernames unique: a taken name is refused and writes nothing', async () => {
    const r = await makeRig();
    const a = await open(r);
    const before = await rows<{ c: string }>(r, 'SELECT count(*) AS c FROM buyers');
    const again = await createAccount(r.deps, input({ username: a.username, display_name: 'Other' }));
    expect(again).toEqual({ ok: false, code: 'taken' });
    expect(await rows(r, 'SELECT count(*) AS c FROM buyers')).toEqual(before);
    expect(await rows(r, 'SELECT 1 FROM buyer_accounts WHERE username = $1', [a.username])).toHaveLength(1);
  });

  it('refuses a weak password, a bad username and a bad country, and writes nothing', async () => {
    const r = await makeRig();
    const before = await rows(r, 'SELECT count(*) AS c FROM buyers');
    expect(await createAccount(r.deps, input({ password: 'short' }))).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'too_short',
    });
    const withName = input({ username: 'carol.x' });
    expect(await createAccount(r.deps, { ...withName, password: 'meet carol.x at nine' })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'contains_username',
    });
    for (const bad of [
      input({ username: 'Bad Name' }),
      input({ username: 'ab' }),
      input({ country: 'gb' }),
      input({ country: 'GBR' }),
      input({ display_name: 'x' }),
      input({ display_name: 'x'.repeat(61) }),
      input({ display_name: '<b>x</b>' }),
    ]) {
      expect(await createAccount(r.deps, bad), JSON.stringify(bad)).toEqual({
        ok: false,
        code: 'invalid_input',
      });
    }
    expect(await rows(r, 'SELECT count(*) AS c FROM buyers')).toEqual(before);
  });

  it('keeps the whole password, spaces included', async () => {
    const r = await makeRig();
    const a = await open(r, { password: '  two spaces either side  ' });
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: '  two spaces either side  ' })).ok).toBe(true);
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: 'two spaces either side' })).ok).toBe(false);
  });
});

describe('verifyAccountLogin', () => {
  it('signs in with the right password and records one account.login row', async () => {
    const r = await makeRig();
    const a = await open(r);
    expect(await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).toEqual({
      ok: true,
      buyer_id: a.buyer_id,
    });
    expect(r.audit.filter((e) => e.action === 'account.login')).toHaveLength(1);
  });

  it('answers a wrong password and an unknown name with the same value', async () => {
    const r = await makeRig();
    const a = await open(r);
    const wrong = await verifyAccountLogin(r.deps, { username: a.username, password: 'not the one' });
    const unknown = await verifyAccountLogin(r.deps, { username: 'nobody.here', password: PASSWORD });
    expect(wrong).toEqual({ ok: false });
    expect(unknown).toEqual(wrong);
  });

  it('records a failed login with a hash of the name, never the name or the password', async () => {
    const r = await makeRig();
    const a = await open(r);
    await verifyAccountLogin(r.deps, { username: a.username, password: 'wrong horse battery' });
    await verifyAccountLogin(r.deps, { username: 'ghost.user', password: 'wrong horse battery' });
    const failed = r.audit.filter((e) => e.action === 'account.login_failed');
    expect(failed).toHaveLength(2);
    for (const e of failed) {
      expect(e.detail['username_hash']).toMatch(/^[0-9a-f]{32}$/);
      const text = JSON.stringify(e);
      expect(text).not.toContain(a.username);
      expect(text).not.toContain('ghost.user');
      expect(text).not.toContain('wrong horse battery');
    }
    expect(failed[0]!.detail['username_hash']).not.toBe(failed[1]!.detail['username_hash']);
  });

  it('locks the account after five failures for 15 minutes, and a locked account answers like a wrong password', async () => {
    const r = await makeRig();
    const a = await open(r);
    expect([ACCOUNT_LOCK_THRESHOLD, ACCOUNT_LOCK_BASE_MS, ACCOUNT_LOCK_CAP_MS]).toEqual([5, 15 * MIN, 60 * MIN]);
    for (let i = 0; i < 5; i++) {
      expect(await verifyAccountLogin(r.deps, { username: a.username, password: `wrong ${String(i)} phrase here` })).toEqual({ ok: false });
    }
    expect(r.audit.filter((e) => e.action === 'account.locked')).toHaveLength(1);
    // the right password is refused inside the window, with the answer of a wrong one
    expect(await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).toEqual({ ok: false });
    r.clock.advance(14 * MIN + 59_000);
    expect(await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).toEqual({ ok: false });
    // attempts inside the window do not extend it and do not add lock rows
    expect(r.audit.filter((e) => e.action === 'account.locked')).toHaveLength(1);
    r.clock.advance(1_000);
    expect(await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).toEqual({
      ok: true,
      buyer_id: a.buyer_id,
    });
    const after = await rows<{ failed_attempts: number; locked_until: unknown }>(
      r,
      'SELECT failed_attempts, locked_until FROM buyer_accounts WHERE buyer_id = $1',
      [a.buyer_id],
    );
    expect(after).toEqual([{ failed_attempts: 0, locked_until: null }]);
  });

  it('doubles the lock on each further failure, up to one hour', async () => {
    const r = await makeRig();
    const a = await open(r);
    const fail = () => verifyAccountLogin(r.deps, { username: a.username, password: 'never the password' });
    const lockedFor = async (): Promise<number> => {
      const x = await rows<{ locked_until: Date | string }>(
        r,
        'SELECT locked_until FROM buyer_accounts WHERE buyer_id = $1',
        [a.buyer_id],
      );
      return new Date(x[0]!.locked_until).getTime() - r.clock.now().getTime();
    };
    for (let i = 0; i < 5; i++) await fail();
    expect(await lockedFor()).toBe(15 * MIN);
    for (const expected of [30 * MIN, 60 * MIN, 60 * MIN]) {
      r.clock.advance((await lockedFor()) + 1);
      await fail();
      expect(await lockedFor()).toBe(expected);
    }
  });

  it('a right password before the fifth failure resets the count', async () => {
    const r = await makeRig();
    const a = await open(r);
    for (let i = 0; i < 4; i++) await verifyAccountLogin(r.deps, { username: a.username, password: 'wrong wrong wrong' });
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).ok).toBe(true);
    for (let i = 0; i < 4; i++) await verifyAccountLogin(r.deps, { username: a.username, password: 'wrong wrong wrong' });
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).ok).toBe(true);
  });

  it('one account locking does not touch another', async () => {
    const r = await makeRig();
    const a = await open(r);
    const b = await open(r);
    for (let i = 0; i < 5; i++) await verifyAccountLogin(r.deps, { username: a.username, password: 'wrong wrong wrong' });
    expect((await verifyAccountLogin(r.deps, { username: b.username, password: PASSWORD })).ok).toBe(true);
  });
});

describe('changePassword', () => {
  it('needs the current password, ends every other session and keeps the current one', async () => {
    const r = await makeRig();
    const a = await open(r);
    const actor = { kind: 'buyer', buyer_id: a.buyer_id } as const;
    const here = await createSession(r.deps, actor);
    const there = await createSession(r.deps, actor);
    const other = await createSession(r.deps, { kind: 'buyer', buyer_id: 'buy_someone_else' });
    const hereId = cookiePair(here.cookie).split('=')[1]!.split('.')[0]!;

    const wrong = await changePassword(r.deps, {
      buyer_id: a.buyer_id,
      current_password: 'not the current one',
      new_password: NEW_PASSWORD,
      keep_session_id: hereId,
    });
    expect(wrong).toEqual({ ok: false, code: 'wrong_password' });
    expect(await resolveSession(r.deps, cookiePair(there.cookie))).toEqual(actor);

    const done = await changePassword(r.deps, {
      buyer_id: a.buyer_id,
      current_password: PASSWORD,
      new_password: NEW_PASSWORD,
      keep_session_id: hereId,
    });
    expect(done).toEqual({ ok: true, revoked: 1 });
    expect(await resolveSession(r.deps, cookiePair(here.cookie))).toEqual(actor);
    expect(await resolveSession(r.deps, cookiePair(there.cookie))).toBeNull();
    expect(await resolveSession(r.deps, cookiePair(other.cookie))).not.toBeNull();
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).ok).toBe(false);
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: NEW_PASSWORD })).ok).toBe(true);
    const changed = r.audit.filter((e) => e.action === 'account.password_changed');
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(r.audit)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(r.audit)).not.toContain(PASSWORD);
  });

  it('applies the policy to the new password and refuses the same one again', async () => {
    const r = await makeRig();
    const a = await open(r);
    const base = { buyer_id: a.buyer_id, current_password: PASSWORD, keep_session_id: null };
    expect(await changePassword(r.deps, { ...base, new_password: 'short one' })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'too_short',
    });
    expect(await changePassword(r.deps, { ...base, new_password: PASSWORD })).toMatchObject({
      ok: false,
      code: 'weak_password',
    });
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: PASSWORD })).ok).toBe(true);
  });

  it('counts wrong current passwords towards the lock, and answers no_account for a buyer with no account', async () => {
    const r = await makeRig();
    const a = await open(r);
    for (let i = 0; i < 5; i++) {
      await changePassword(r.deps, {
        buyer_id: a.buyer_id,
        current_password: 'wrong wrong wrong',
        new_password: NEW_PASSWORD,
        keep_session_id: null,
      });
    }
    expect(
      await changePassword(r.deps, {
        buyer_id: a.buyer_id,
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
        keep_session_id: null,
      }),
    ).toEqual({ ok: false, code: 'wrong_password' });
    expect(
      await changePassword(r.deps, {
        buyer_id: 'buy_persona_a',
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
        keep_session_id: null,
      }),
    ).toEqual({ ok: false, code: 'no_account' });
  });
});

describe('revokeBuyerSessions', () => {
  it('ends every session of that buyer, writes account.sessions_revoked, and touches no other buyer', async () => {
    const r = await makeRig();
    const actor = { kind: 'buyer', buyer_id: 'buy_rev_one' } as const;
    const s1 = await createSession(r.deps, actor);
    const s2 = await createSession(r.deps, actor);
    const o = await createSession(r.deps, { kind: 'buyer', buyer_id: 'buy_rev_two' });
    expect(await revokeBuyerSessions(r.deps, { buyer_id: actor.buyer_id, keep_session_id: null })).toBe(2);
    expect(await resolveSession(r.deps, cookiePair(s1.cookie))).toBeNull();
    expect(await resolveSession(r.deps, cookiePair(s2.cookie))).toBeNull();
    expect(await resolveSession(r.deps, cookiePair(o.cookie))).not.toBeNull();
    expect(r.audit.filter((e) => e.action === 'account.sessions_revoked')).toHaveLength(1);
  });
});

describe('resetPasswordForOperator', () => {
  it('sets a new password, ends all sessions, clears a lock and writes one audit row', async () => {
    const r = await makeRig();
    const a = await open(r);
    const actor = { kind: 'buyer', buyer_id: a.buyer_id } as const;
    const s = await createSession(r.deps, actor);
    for (let i = 0; i < 5; i++) await verifyAccountLogin(r.deps, { username: a.username, password: 'wrong wrong wrong' });
    const before = r.audit.length;
    const res = await resetPasswordForOperator(r.deps, {
      username: a.username,
      new_password: NEW_PASSWORD,
      operator_id: 'opr_vikram',
    });
    expect(res).toEqual({ ok: true, revoked: 1 });
    expect(await resolveSession(r.deps, cookiePair(s.cookie))).toBeNull();
    expect((await verifyAccountLogin(r.deps, { username: a.username, password: NEW_PASSWORD })).ok).toBe(true);
    const added = r.audit.slice(before).filter((e) => e.action.startsWith('account.password'));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ actor: { kind: 'operator', operator_id: 'opr_vikram' }, target: a.buyer_id });
    expect(JSON.stringify(added)).not.toContain(NEW_PASSWORD);
  });

  it('applies the policy and refuses an unknown name', async () => {
    const r = await makeRig();
    const a = await open(r);
    expect(
      await resetPasswordForOperator(r.deps, { username: a.username, new_password: 'tiny', operator_id: 'opr_v' }),
    ).toEqual({ ok: false, code: 'weak_password', reason: 'too_short' });
    expect(
      await resetPasswordForOperator(r.deps, { username: 'no.such.user', new_password: NEW_PASSWORD, operator_id: 'opr_v' }),
    ).toEqual({ ok: false, code: 'unknown_account' });
  });
});
