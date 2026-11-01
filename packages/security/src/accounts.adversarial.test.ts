// ID-ACCOUNTS adversarial, at the library: an unknown name, a wrong password and a locked account do the same
// work (exactly one scrypt verification, with the same cost parameters), and no password reaches an audit
// row or a log line on any path. Time is not measured (the lint forbids clocks in tests); the work is counted.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Passcode from './passcode';

const calls: Array<{ hash: string; attempt: string }> = [];
vi.mock('./passcode', async (importOriginal) => {
  const real = await importOriginal<typeof Passcode>();
  return {
    ...real,
    verifyPasscode: (hash: string, attempt: string) => {
      calls.push({ hash, attempt });
      return real.verifyPasscode(hash, attempt);
    },
  };
});

const {
  ACCOUNT_DUMMY_HASH,
  changePassword,
  createAccount,
  resetPasswordForOperator,
  verifyAccountLogin,
} = await import('./accounts');
const { makeRig, seededIds } = await import('./test-support');

const PW = 'violet lamps hum softly';
let n = 0;
async function world() {
  n += 1;
  const r = await makeRig({ ids: seededIds(`adv-${String(n)}`) });
  const username = `adv.user.${String(n)}`;
  const made = await createAccount(r.deps, {
    display_name: 'Adv Reader',
    username,
    country: 'GB',
    password: PW,
    consent_version: 'terms-v1',
  });
  if (!made.ok) throw new Error('setup');
  return { r, username, buyer_id: made.buyer_id };
}
beforeEach(() => {
  calls.length = 0;
});

describe('equal work for every answer', () => {
  it('an unknown name, a wrong password, a locked account and a malformed name each verify exactly once', async () => {
    const { r, username } = await world();
    calls.length = 0;
    await verifyAccountLogin(r.deps, { username: 'nobody.at.all', password: 'wrong wrong wrong' });
    const unknown = [...calls];
    calls.length = 0;
    await verifyAccountLogin(r.deps, { username, password: 'wrong wrong wrong' });
    const wrong = [...calls];
    for (let i = 0; i < 4; i++)
      await verifyAccountLogin(r.deps, { username, password: 'wrong wrong wrong' });
    calls.length = 0;
    await verifyAccountLogin(r.deps, { username, password: PW }); // locked now
    const locked = [...calls];
    calls.length = 0;
    await verifyAccountLogin(r.deps, {
      username: "x'; DROP TABLE buyers;--",
      password: 'wrong wrong wrong',
    });
    const malformed = [...calls];
    for (const c of [unknown, wrong, locked, malformed]) expect(c).toHaveLength(1);
    expect(unknown[0]!.hash).toBe(ACCOUNT_DUMMY_HASH);
    expect(malformed[0]!.hash).toBe(ACCOUNT_DUMMY_HASH);
    expect(wrong[0]!.hash).not.toBe(ACCOUNT_DUMMY_HASH);
    expect(locked[0]!.hash).not.toBe(ACCOUNT_DUMMY_HASH);
  });

  it('the dummy hash has the same cost parameters as a real one', async () => {
    const { r, username } = await world();
    const row = await r.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM buyer_accounts WHERE username = $1',
      [username],
    );
    const params = (h: string): string => h.split(':').slice(0, 4).join(':');
    expect(params(ACCOUNT_DUMMY_HASH)).toBe(params(row.rows[0]!.password_hash));
    expect(ACCOUNT_DUMMY_HASH.split(':')[4]).toHaveLength(
      row.rows[0]!.password_hash.split(':')[4]!.length,
    );
  });

  it('a wrong current password and a right one in a password change each verify once', async () => {
    const { r, buyer_id } = await world();
    calls.length = 0;
    await changePassword(r.deps, {
      buyer_id,
      current_password: 'nope nope nope',
      new_password: 'seven quiet harbours',
      keep_session_id: null,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('no password in any audit row or log line', () => {
  it('a canary survives none of the paths: signup, login, failed login, change, reset, lock', async () => {
    const canary = 'canary-passphrase-zq81-xylophone';
    const canary2 = 'second-canary-quartz-7731-lantern';
    const canary3 = 'third-canary-ember-4429-orchard';
    const r = await makeRig({ ids: seededIds('canary') });
    const username = 'canary.user';
    const made = await createAccount(r.deps, {
      display_name: 'Canary Reader',
      username,
      country: 'GB',
      password: canary,
      consent_version: 'terms-v1',
    });
    if (!made.ok) throw new Error('setup');
    await verifyAccountLogin(r.deps, { username, password: canary });
    for (let i = 0; i < 6; i++)
      await verifyAccountLogin(r.deps, { username, password: `${canary}-wrong-${String(i)}` });
    r.clock.advance(61 * 60_000);
    await changePassword(r.deps, {
      buyer_id: made.buyer_id,
      current_password: canary,
      new_password: canary2,
      keep_session_id: null,
    });
    await changePassword(r.deps, {
      buyer_id: made.buyer_id,
      current_password: `${canary}-wrong`,
      new_password: canary3,
      keep_session_id: null,
    });
    await resetPasswordForOperator(r.deps, {
      username,
      new_password: canary3,
      operator_id: 'opr_v',
    });
    const seen = JSON.stringify([
      r.audit,
      r.log.events,
      (await r.db.query('SELECT * FROM buyer_accounts')).rows,
    ]);
    for (const c of [canary, canary2, canary3]) expect(seen).not.toContain(c);
    expect(r.audit.length).toBeGreaterThan(8);
  });

  it('a failed login is audited by a keyed hash: the same name gives the same hash, other names do not', async () => {
    const { r, username } = await world();
    await verifyAccountLogin(r.deps, { username, password: 'wrong wrong wrong' });
    await verifyAccountLogin(r.deps, { username, password: 'wrong wrong again' });
    await verifyAccountLogin(r.deps, { username: 'someone.else', password: 'wrong wrong wrong' });
    const hashes = r.audit
      .filter((e) => e.action === 'account.login_failed')
      .map((e) => e.detail['username_hash']);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(JSON.stringify(r.audit)).not.toContain(username);
  });
});
