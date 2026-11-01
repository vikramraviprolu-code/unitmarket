// ID-ACCOUNTS through the real routes on an offline app: signup, login, rotation, change of password,
// sign out everywhere, the lock, and the persona sign in left alone. Passwords are fictional test values.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PW2,
  bodyShape,
  bootAccounts,
  errorOf,
  freshIp,
  got,
  newAccount,
  newName,
  post,
  signupBody,
} from './accounts-support';
import type { AccountsWorld } from './accounts-support';
import { PASSCODE, call, signIn } from './support';

vi.mock('server-only', () => ({}));

let w: AccountsWorld;
beforeAll(async () => {
  w = await bootAccounts();
});
afterAll(async () => {
  await w.app.close();
});

const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await w.app.db.query<T>(sql, p)).rows;
const libraryStatus = async (cookie: string): Promise<number> =>
  (await call(w.library.GET, { url: '/api/library', session: { cookie, csrf: '' } })).status;
const login = (username: string, password: string, ip?: string, cookie?: string) =>
  post(
    w.login.POST,
    '/api/accounts/login',
    { username, password },
    { ...(ip ? { ip } : {}), ...(cookie ? { cookie } : {}) },
  );

describe('route declarations', () => {
  it('are public or buyer, CSRF checked, small, and limited', () => {
    expect(w.signup.routeMeta).toMatchObject({
      path: '/api/accounts',
      method: 'POST',
      auth: 'public',
      csrf: true,
      risk: 'high',
    });
    expect(w.signup.routeMeta.rate?.per).toBe('ip');
    expect(w.login.routeMeta).toMatchObject({
      path: '/api/accounts/login',
      method: 'POST',
      auth: 'public',
      csrf: true,
      risk: 'high',
      rate_target: 'username',
    });
    expect(w.login.routeMeta.rate).toMatchObject({ per: 'ip', limit: 5, window_ms: 900_000 });
    expect(w.login.routeMeta.rate_ip).toMatchObject({ per: 'ip', limit: 30 });
    expect(w.password.routeMeta).toMatchObject({
      path: '/api/accounts/password',
      method: 'POST',
      auth: 'buyer',
      csrf: true,
      risk: 'high',
    });
    expect(w.revokeAll.routeMeta).toMatchObject({
      path: '/api/accounts/sessions/revoke-all',
      method: 'POST',
      auth: 'buyer',
      csrf: true,
    });
    for (const m of [w.signup, w.login, w.password, w.revokeAll]) {
      expect(m.routeMeta.max_body_bytes).toBeLessThanOrEqual(4096);
      expect(m.routeMeta.idempotent).toBe(false);
    }
  });
});

describe('POST /api/accounts (signup)', () => {
  it('creates the buyer, the account, two consents and the audit rows, and signs the buyer in', async () => {
    const body = signupBody();
    const g = await got(await post(w.signup.POST, '/api/accounts', body));
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ actor_kind: 'buyer' });
    expect(typeof g.csrf).toBe('string');
    expect(g.setCookie).toMatch(/^__Host-ums_s=ses_[0-9a-z]{26}\./);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=28800'])
      expect(g.setCookie).toContain(flag);
    expect(g.setCookie).not.toMatch(/Domain=/i);
    expect(g.text).not.toMatch(/buy_|ses_|aud_/);
    const acct = await q<{ buyer_id: string }>(
      'SELECT buyer_id FROM buyer_accounts WHERE username = $1',
      [body['username']],
    );
    expect(acct).toHaveLength(1);
    const id = acct[0]!.buyer_id;
    expect(
      await q('SELECT auth_subject, display_name, country FROM buyers WHERE id = $1', [id]),
    ).toEqual([
      {
        auth_subject: `account:${String(body['username'])}`,
        display_name: 'Test Reader',
        country: 'GB',
      },
    ]);
    expect(
      (
        await q<{ kind: string }>('SELECT kind FROM consents WHERE buyer_id = $1 ORDER BY kind', [
          id,
        ])
      ).map((c) => c.kind),
    ).toEqual(['privacy', 'terms']);
    const actions = (
      await q<{ action: string }>(
        'SELECT action FROM audit_log WHERE actor_id = $1 OR target = $1',
        [id],
      )
    ).map((a) => a.action);
    expect(actions).toContain('account.signup');
    expect(actions).toContain('session.create');
    expect(await libraryStatus(g.cookie!)).toBe(200);
  });

  it('answers a filled honeypot like a success and stores nothing', async () => {
    const before = await q<{ c: string }>('SELECT count(*) AS c FROM buyers');
    const body = signupBody({ extra_k7q: 'I am a bot' });
    const g = await got(await post(w.signup.POST, '/api/accounts', body));
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ actor_kind: 'buyer' });
    expect(typeof g.csrf).toBe('string');
    expect(await q<{ c: string }>('SELECT count(*) AS c FROM buyers')).toEqual(before);
    expect(
      await q('SELECT 1 FROM buyer_accounts WHERE username = $1', [body['username']]),
    ).toHaveLength(0);
    // the pretend session does not exist
    expect(g.cookie === null || (await libraryStatus(g.cookie)) === 401).toBe(true);
  });

  it('answers a taken username with 409 and the one sentence, and only here', async () => {
    const a = await newAccount(w);
    const g = await got(
      await post(w.signup.POST, '/api/accounts', signupBody({ username: a.username })),
    );
    expect(g.status).toBe(409);
    expect(errorOf(g)).toMatchObject({ code: 'taken', message: 'That username is taken.' });
  });

  it('refuses a weak password with the reason, a missing tick, and a bad shape; stores nothing', async () => {
    const before = await q<{ c: string }>('SELECT count(*) AS c FROM buyers');
    const weak = await got(
      await post(w.signup.POST, '/api/accounts', signupBody({ password: 'short' })),
    );
    expect(weak.status).toBe(422);
    expect(errorOf(weak).code).toBe('weak_password');
    expect(errorOf(weak).message).toContain('at least 12');
    const name = newName();
    const inName = await got(
      await post(
        w.signup.POST,
        '/api/accounts',
        signupBody({ username: name, password: `my pass ${name} ok` }),
      ),
    );
    expect(errorOf(inName)).toMatchObject({
      code: 'weak_password',
      message: 'The password must not contain your username.',
    });
    for (const bad of [
      { accept_terms: false },
      { username: 'Has Capitals' },
      { country: 'gb' },
      { display_name: 'x' },
      { display_name: '<script>alert(1)</script>' },
    ]) {
      const g = await got(await post(w.signup.POST, '/api/accounts', signupBody(bad)));
      expect([422, 400], JSON.stringify(bad)).toContain(g.status);
    }
    expect(await q<{ c: string }>('SELECT count(*) AS c FROM buyers')).toEqual(before);
  });

  it('allows 5 signups an hour from one address and answers the 6th with 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect((await post(w.signup.POST, '/api/accounts', signupBody(), { ip })).status).toBe(200);
    }
    const sixth = await got(await post(w.signup.POST, '/api/accounts', signupBody(), { ip }));
    expect(sixth.status).toBe(429);
    expect(errorOf(sixth).code).toBe('rate_limited');
    expect((await post(w.signup.POST, '/api/accounts', signupBody())).status).toBe(200);
  });

  it('rotates: a session cookie present at signup is ended and a new one is issued', async () => {
    const first = await newAccount(w);
    expect(await libraryStatus(first.cookie)).toBe(200);
    const g = await got(
      await post(w.signup.POST, '/api/accounts', signupBody(), { cookie: first.cookie }),
    );
    expect(g.status).toBe(200);
    expect(g.cookie).not.toBe(first.cookie);
    expect(await libraryStatus(first.cookie)).toBe(401);
    expect(await libraryStatus(g.cookie!)).toBe(200);
  });
});

describe('POST /api/accounts/login', () => {
  it('signs in with the right password, sets a new cookie and ends the one the browser sent', async () => {
    const a = await newAccount(w);
    const g = await got(await login(a.username, a.password, undefined, a.cookie));
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ actor_kind: 'buyer' });
    expect(g.cookie).not.toBeNull();
    expect(g.cookie).not.toBe(a.cookie);
    expect(await libraryStatus(a.cookie)).toBe(401);
    expect(await libraryStatus(g.cookie!)).toBe(200);
    expect(g.text).not.toMatch(/buy_|ses_/);
  });

  it('gives a wrong password and an unknown name the same status and the same body', async () => {
    const a = await newAccount(w);
    const wrong = await got(await login(a.username, 'not the password at all'));
    const unknown = await got(await login('nobody.at.all', 'not the password at all'));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bodyShape(wrong)).toBe(bodyShape(unknown));
    expect(errorOf(wrong)).toEqual({
      code: 'sign_in_failed',
      message: 'That username or password did not work.',
    });
    expect(wrong.setCookie).toBe('');
  });

  it('locks the account after five wrong passwords from different places and answers the right one like a wrong one', async () => {
    const a = await newAccount(w);
    for (let i = 0; i < 5; i++)
      expect((await login(a.username, `wrong wrong ${String(i)}`, freshIp())).status).toBe(401);
    const locked = await got(await login(a.username, a.password, freshIp()));
    expect(locked.status).toBe(401);
    expect(errorOf(locked).message).toBe('That username or password did not work.');
    expect(locked.text).not.toMatch(/lock/i);
    expect(locked.retryAfter).toBeNull();
    // after the window, the right password signs in again
    await w.app.db.query(
      "UPDATE buyer_accounts SET locked_until = '2000-01-01T00:00:00Z' WHERE username = $1",
      [a.username],
    );
    expect((await login(a.username, a.password, freshIp())).status).toBe(200);
  });

  it('answers the 6th try from one address and name within 15 minutes with 429 and Retry-After', async () => {
    const a = await newAccount(w);
    const ip = freshIp();
    for (let i = 0; i < 4; i++)
      expect((await login(a.username, 'wrong wrong wrong', ip)).status).toBe(401);
    expect((await login('some.other.name', 'wrong wrong wrong', ip)).status).toBe(401);
    const fifth = await login(a.username, 'wrong wrong wrong', ip);
    expect(fifth.status).toBe(401);
    const sixth = await got(await login(a.username, 'wrong wrong wrong', ip));
    expect(sixth.status).toBe(429);
    expect(Number(sixth.retryAfter)).toBeGreaterThan(0);
  });
});

describe('POST /api/accounts/password', () => {
  it('changes the password, keeps this session, ends the others and refuses the old password after', async () => {
    const a = await newAccount(w);
    const other = await got(await login(a.username, a.password));
    const res = await got(
      await post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: a.password, new_password: PW2 },
        { cookie: a.cookie, csrf: a.csrf },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await libraryStatus(a.cookie)).toBe(200);
    expect(await libraryStatus(other.cookie!)).toBe(401);
    expect((await login(a.username, a.password)).status).toBe(401);
    expect((await login(a.username, PW2)).status).toBe(200);
    const actions = (
      await q<{ action: string }>(
        "SELECT action FROM audit_log WHERE action = 'account.password_changed'",
      )
    ).length;
    expect(actions).toBeGreaterThan(0);
  });

  it('refuses a wrong current password (403 free, 401 shape) and a weak new one', async () => {
    const a = await newAccount(w);
    const bad = await got(
      await post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: 'nope nope nope', new_password: PW2 },
        { cookie: a.cookie, csrf: a.csrf },
      ),
    );
    expect(bad.status).toBe(401);
    expect(errorOf(bad).code).toBe('wrong_password');
    const weak = await got(
      await post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: a.password, new_password: 'tiny' },
        { cookie: a.cookie, csrf: a.csrf },
      ),
    );
    expect(weak.status).toBe(422);
    expect(errorOf(weak).code).toBe('weak_password');
    expect((await login(a.username, a.password)).status).toBe(200);
  });

  it('needs a buyer session and the CSRF token', async () => {
    const a = await newAccount(w);
    const body = { current_password: a.password, new_password: PW2 };
    expect((await post(w.password.POST, '/api/accounts/password', body)).status).toBe(401);
    expect(
      (await post(w.password.POST, '/api/accounts/password', body, { cookie: a.cookie })).status,
    ).toBe(403);
    expect(
      (
        await post(w.password.POST, '/api/accounts/password', body, {
          cookie: a.cookie,
          csrf: 'wrong',
        })
      ).status,
    ).toBe(403);
  });

  it('a test persona has no password to change', async () => {
    const s = (await signIn(w.session.POST, 'buyer-a'))!;
    const g = await got(
      await post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: PASSCODE, new_password: PW2 },
        { cookie: s.cookie, csrf: s.csrf },
      ),
    );
    expect(g.status).toBe(403);
    expect(errorOf(g).code).toBe('forbidden');
  });
});

describe('POST /api/accounts/sessions/revoke-all', () => {
  it('ends every session of the buyer, this one too, clears the cookie and writes account.sessions_revoked', async () => {
    const a = await newAccount(w);
    const other = await got(await login(a.username, a.password));
    const res = await got(
      await post(
        w.revokeAll.POST,
        '/api/accounts/sessions/revoke-all',
        {},
        { cookie: a.cookie, csrf: a.csrf },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/__Host-ums_s=; .*Max-Age=0/);
    expect(await libraryStatus(a.cookie)).toBe(401);
    expect(await libraryStatus(other.cookie!)).toBe(401);
    expect(
      (await q("SELECT 1 FROM audit_log WHERE action = 'account.sessions_revoked'")).length,
    ).toBeGreaterThan(0);
    expect((await login(a.username, a.password)).status).toBe(200);
  });
});

describe('the account view and the persona sign in', () => {
  it('shows the account to its buyer and nothing for a persona', async () => {
    const a = await newAccount(w);
    const actor = await w.app.engine.actorFromCookie(a.cookie);
    expect(actor?.kind).toBe('buyer');
    expect(await w.app.engine.accounts.view(actor!)).toMatchObject({
      username: a.username,
      display_name: 'Test Reader',
      country: 'GB',
    });
    const persona = (await signIn(w.session.POST, 'buyer-b'))!;
    expect(
      await w.app.engine.accounts.view((await w.app.engine.actorFromCookie(persona.cookie))!),
    ).toBeNull();
  });

  it('keeps the test persona sign in working: right passcode in, wrong passcode out', async () => {
    expect(await signIn(w.session.POST, 'buyer-a')).not.toBeNull();
    expect(await signIn(w.session.POST, 'buyer-a', 'not the passcode')).toBeNull();
  });
});
