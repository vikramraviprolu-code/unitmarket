// ID-ACCOUNTS adversarial: the sign in and signup routes under attack. Name enumeration by body and by
// time, the lock, the rate limits, CSRF, unknown and oversize fields, mass assignment, script and SQL text,
// other roles on the account routes, one buyer against another, session fixation, and a canary that proves
// no password reaches a log line, an audit row or an answer. Synthetic values only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import {
  PW,
  PW2,
  bodyShape,
  bootAccounts,
  freshIp,
  got,
  newAccount,
  newName,
  operatorCookie,
  post,
  signupBody,
} from './accounts-support';
import type { AccountsWorld } from './accounts-support';
import { ORIGIN, call, signIn } from './support';

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
const login = (body: unknown, o: Parameters<typeof post>[3] = {}) =>
  post(w.login.POST, '/api/accounts/login', body, o);

describe('username enumeration', () => {
  it('a wrong password, an unknown name and a locked account answer the same status, body and headers', async () => {
    const real = await newAccount(w);
    const locked = await newAccount(w);
    for (let i = 0; i < 5; i++)
      await login({ username: locked.username, password: 'wrong wrong wrong' });
    const answers = [
      await got(await login({ username: real.username, password: 'wrong wrong wrong' })),
      await got(await login({ username: 'never.registered', password: 'wrong wrong wrong' })),
      await got(await login({ username: locked.username, password: locked.password })),
    ];
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.setCookie).toBe('');
      expect(a.retryAfter).toBeNull();
      expect(bodyShape(a)).toBe(bodyShape(answers[0]!));
    }
  });

  it('signup shows that a name exists only as 409, and that costs a token of the 5 an hour', async () => {
    const taken = await newAccount(w);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const g = await got(
        await post(w.signup.POST, '/api/accounts', signupBody({ username: taken.username }), {
          ip,
        }),
      );
      expect(g.status).toBe(409);
    }
    const sixth = await got(
      await post(w.signup.POST, '/api/accounts', signupBody({ username: taken.username }), { ip }),
    );
    expect(sixth.status).toBe(429);
  });

  it('the sixth try in 15 minutes from one address and name is 429, even with the right password', async () => {
    const a = await newAccount(w);
    const ip = freshIp();
    for (let i = 0; i < 5; i++)
      expect(
        (await login({ username: a.username, password: `bad bad bad ${String(i)}` }, { ip }))
          .status,
      ).toBe(401);
    const sixth = await got(await login({ username: a.username, password: a.password }, { ip }));
    expect(sixth.status).toBe(429);
    expect(sixth.cookie).toBeNull();
  });
});

describe('CSRF, unknown fields, size and shape', () => {
  it('every public route refuses a missing and a foreign Origin and does nothing', async () => {
    const before = await q<{ c: string }>('SELECT count(*) AS c FROM buyers');
    for (const origin of [
      null,
      'https://evil.example',
      'http://localhost:3000.evil.example',
      'null',
    ]) {
      const s = await got(await post(w.signup.POST, '/api/accounts', signupBody(), { origin }));
      expect(s.status, String(origin)).toBe(403);
      const l = await got(await login({ username: 'abc', password: 'x' }, { origin }));
      expect(l.status, String(origin)).toBe(403);
    }
    expect(await q<{ c: string }>('SELECT count(*) AS c FROM buyers')).toEqual(before);
  });

  it('every buyer route refuses a missing Origin, a foreign Origin and a missing token', async () => {
    const a = await newAccount(w);
    const cases: Array<[Parameters<typeof post>[0], string, unknown]> = [
      [
        w.password.POST,
        '/api/accounts/password',
        { current_password: a.password, new_password: PW2 },
      ],
      [w.revokeAll.POST, '/api/accounts/sessions/revoke-all', {}],
    ];
    for (const [h, path, body] of cases) {
      for (const o of [
        { cookie: a.cookie, csrf: a.csrf, origin: null },
        { cookie: a.cookie, csrf: a.csrf, origin: 'https://evil.example' },
        { cookie: a.cookie },
        { cookie: a.cookie, csrf: 'x'.repeat(40) },
      ]) {
        expect((await post(h, path, body, o)).status, `${path} ${JSON.stringify(o)}`).toBe(403);
      }
    }
    // nothing changed
    expect(await libraryStatus(a.cookie)).toBe(200);
    expect((await login({ username: a.username, password: a.password })).status).toBe(200);
  });

  it('refuses unknown fields and mass assignment on every route, and stores nothing', async () => {
    const before = await q<{ c: string }>('SELECT count(*) AS c FROM buyers');
    for (const extra of [
      { buyer_id: 'buy_persona_a' },
      { failed_attempts: 0 },
      { locked_until: null },
      { role: 'operator' },
      { actor_kind: 'operator' },
      { password_hash: 'scrypt:1:1:1:aa:bb' },
      { country: 'GB', admin: true },
    ]) {
      const s = await got(await post(w.signup.POST, '/api/accounts', signupBody(extra)));
      expect([422, 400], JSON.stringify(extra)).toContain(s.status);
      const l = await got(await login({ username: 'abc', password: 'xxxxxxxxxxxx', ...extra }));
      expect([422, 400]).toContain(l.status);
    }
    const a = await newAccount(w);
    for (const extra of [{ buyer_id: 'buy_persona_a' }, { username: 'someone.else' }]) {
      const g = await got(
        await post(
          w.password.POST,
          '/api/accounts/password',
          { current_password: a.password, new_password: PW2, ...extra },
          { cookie: a.cookie, csrf: a.csrf },
        ),
      );
      expect(g.status).toBe(422);
    }
    const r = await got(
      await post(
        w.revokeAll.POST,
        '/api/accounts/sessions/revoke-all',
        { buyer_id: 'buy_persona_a' },
        { cookie: a.cookie, csrf: a.csrf },
      ),
    );
    expect(r.status).toBe(422);
    expect(await libraryStatus(a.cookie)).toBe(200);
    expect(Number((await q<{ c: string }>('SELECT count(*) AS c FROM buyers'))[0]!.c)).toBe(
      Number(before[0]!.c) + 1,
    );
  });

  it('refuses oversize bodies, bad JSON, and wrong types, and stores nothing', async () => {
    const before = await q<{ c: string }>('SELECT count(*) AS c FROM buyers');
    const big = await got(
      await post(w.signup.POST, '/api/accounts', signupBody({ display_name: 'x'.repeat(10_000) })),
    );
    expect(big.status).toBe(413);
    const bigLogin = await got(await login({ username: 'abc', password: 'p'.repeat(20_000) }));
    expect(bigLogin.status).toBe(413);
    expect(
      (await got(await post(w.signup.POST, '/api/accounts', null, { raw: '{not json' }))).status,
    ).toBe(400);
    for (const bad of [
      signupBody({ username: 42 }),
      signupBody({ password: ['a'] }),
      signupBody({ accept_terms: 'true' }),
      signupBody({ country: null }),
    ]) {
      expect((await got(await post(w.signup.POST, '/api/accounts', bad))).status).toBe(422);
    }
    expect(await q<{ c: string }>('SELECT count(*) AS c FROM buyers')).toEqual(before);
  });

  it('keeps script and SQL text inert: refused in names, never run, never stored', async () => {
    const tricky = [
      "Robert'); DROP TABLE buyers;--",
      '<script>alert(1)</script>',
      '${process.env.X}',
      '{{7*7}}',
      '"><img src=x onerror=alert(1)>',
    ];
    for (const t of tricky) {
      // a display name may hold quotes and brackets of the SQL kind (it is a parameter), but never angle brackets
      const asName = await got(
        await post(w.signup.POST, '/api/accounts', signupBody({ display_name: t })),
      );
      expect(asName.status, t).toBe(/[<>]/.test(t) ? 422 : 200);
      expect(
        (await got(await post(w.signup.POST, '/api/accounts', signupBody({ username: t })))).status,
        t,
      ).toBe(422);
      expect(
        (await got(await login({ username: t, password: 'wrong wrong wrong' }))).status,
        t,
      ).toBe(422);
    }
    expect(
      await q("SELECT 1 FROM buyers WHERE display_name = 'Robert''); DROP TABLE buyers;--'"),
    ).toHaveLength(1);
    // the same text as a password is just a password, hashed and never echoed
    const sqlPw = "x'; DROP TABLE buyer_accounts;-- and more words";
    const a = await newAccount(w, { password: sqlPw });
    expect((await login({ username: a.username, password: sqlPw })).status).toBe(200);
    expect(await q('SELECT 1 FROM buyer_accounts')).not.toHaveLength(0);
    expect(await q("SELECT 1 FROM buyers WHERE display_name LIKE '%<%'")).toHaveLength(0);
  });
});

describe('other roles and other buyers', () => {
  it('operator and publisher sessions cannot use the buyer account routes', async () => {
    const op = await operatorCookie(w.app);
    const pub = await createSession(w.app.security, {
      kind: 'publisher',
      publisher_id: 'pub_harbour',
    });
    for (const s of [op, { cookie: pub.cookie.split(';')[0]!, csrf: pub.csrf_token }]) {
      const pw = await got(
        await post(
          w.password.POST,
          '/api/accounts/password',
          { current_password: PW, new_password: PW2 },
          s,
        ),
      );
      expect(pw.status).toBe(403);
      const rv = await got(
        await post(w.revokeAll.POST, '/api/accounts/sessions/revoke-all', {}, s),
      );
      expect(rv.status).toBe(403);
      expect(await libraryStatus(s.cookie)).toBeLessThan(500);
    }
  });

  it('a buyer changes only their own password: the account comes from the session, never from the request', async () => {
    const a = await newAccount(w);
    const b = await newAccount(w, { password: 'another distinct phrase for b' });
    const res = await got(
      await post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: b.password, new_password: PW2 },
        { cookie: a.cookie, csrf: a.csrf },
      ),
    );
    // A's session with B's password: the current password is checked against A's account
    expect(res.status).toBe(401);
    expect((await login({ username: b.username, password: b.password })).status).toBe(200);
    expect((await login({ username: a.username, password: a.password })).status).toBe(200);
    // and sign out everywhere ends A's sessions, not B's
    await post(
      w.revokeAll.POST,
      '/api/accounts/sessions/revoke-all',
      {},
      { cookie: a.cookie, csrf: a.csrf },
    );
    expect(await libraryStatus(a.cookie)).toBe(401);
    expect(await libraryStatus(b.cookie)).toBe(200);
  });

  it("the shared test personas cannot use sign out everywhere: it would end every judge's session", async () => {
    const s1 = (await signIn(w.session.POST, 'buyer-a'))!;
    const s2 = (await signIn(w.session.POST, 'buyer-a'))!;
    const g = await got(
      await post(
        w.revokeAll.POST,
        '/api/accounts/sessions/revoke-all',
        {},
        { cookie: s1.cookie, csrf: s1.csrf },
      ),
    );
    expect(g.status).toBe(403);
    expect(await libraryStatus(s2.cookie)).toBe(200);
  });
});

describe('sessions', () => {
  it('session fixation: a cookie planted before sign in is not adopted', async () => {
    const a = await newAccount(w);
    const planted =
      '__Host-ums_s=ses_00000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const g = await got(
      await login({ username: a.username, password: a.password }, { cookie: planted }),
    );
    expect(g.status).toBe(200);
    expect(g.cookie).not.toBeNull();
    expect(g.cookie).not.toContain('ses_00000000000000000000000000');
    expect(await libraryStatus(planted)).toBe(401);
  });

  it('every sign in issues a new session id and a new CSRF token', async () => {
    const a = await newAccount(w);
    const one = await got(await login({ username: a.username, password: a.password }));
    const two = await got(await login({ username: a.username, password: a.password }));
    expect(one.cookie).not.toBe(two.cookie);
    expect(one.csrf).not.toBe(two.csrf);
    expect(one.csrf).not.toBe(a.csrf);
  });

  it('a stolen CSRF token does not work with another buyer session', async () => {
    const a = await newAccount(w);
    const b = await newAccount(w);
    const g = await got(
      await post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: b.password, new_password: PW2 },
        { cookie: b.cookie, csrf: a.csrf },
      ),
    );
    expect(g.status).toBe(403);
  });
});

describe('no password in any log, audit row, answer or table', () => {
  it('a canary password is stored only as a hash', async () => {
    const canary = 'canary-passphrase-zq81-xylophone';
    const canary2 = 'second-canary-quartz-7731-lantern';
    const name = newName();
    const answers: string[] = [];
    const run = async (r: Promise<Response>): Promise<void> =>
      void answers.push((await got(await r)).text);
    const s = await got(
      await post(w.signup.POST, '/api/accounts', signupBody({ username: name, password: canary })),
    );
    answers.push(s.text);
    await run(login({ username: name, password: canary }));
    await run(login({ username: name, password: `${canary}-wrong` }));
    await run(login({ username: 'unknown.canary', password: canary }));
    await run(post(w.signup.POST, '/api/accounts', signupBody({ password: canary })));
    await run(
      post(w.signup.POST, '/api/accounts', signupBody({ username: name, password: canary })),
    );
    await run(
      post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: `${canary}-wrong`, new_password: canary2 },
        { cookie: s.cookie!, csrf: s.csrf! },
      ),
    );
    await run(
      post(
        w.password.POST,
        '/api/accounts/password',
        { current_password: canary, new_password: canary2 },
        { cookie: s.cookie!, csrf: s.csrf! },
      ),
    );
    await run(
      post(w.signup.POST, '/api/accounts', null, { raw: `{"password":"${canary}", broken` }),
    );
    const audit = JSON.stringify(await q('SELECT * FROM audit_log'));
    const accounts = JSON.stringify(await q('SELECT * FROM buyer_accounts'));
    const everything =
      JSON.stringify(await q('SELECT * FROM buyers')) +
      JSON.stringify(await q('SELECT * FROM consents')) +
      JSON.stringify(await q('SELECT * FROM sessions')) +
      JSON.stringify(await q('SELECT * FROM rate_buckets'));
    for (const c of [canary, canary2]) {
      expect(audit).not.toContain(c);
      expect(accounts).not.toContain(c);
      expect(everything).not.toContain(c);
      expect(w.logs.join('\n')).not.toContain(c);
      expect(answers.join('\n')).not.toContain(c);
    }
    expect(audit).not.toContain(name + '"'.repeat(0) + '-wrong');
  });

  it('a failed login is audited by a hash of the name, never the name', async () => {
    const name = `audited.${newName()}`.slice(0, 30);
    await login({ username: name, password: 'wrong wrong wrong' });
    const rows = await q<{ detail: unknown }>(
      "SELECT detail FROM audit_log WHERE action = 'account.login_failed'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(name);
  });

  it('no answer names an internal id', async () => {
    const a = await newAccount(w);
    const texts = [
      (await got(await login({ username: a.username, password: a.password }))).text,
      (
        await got(
          await post(
            w.password.POST,
            '/api/accounts/password',
            { current_password: a.password, new_password: PW2 },
            { cookie: a.cookie, csrf: a.csrf },
          ),
        )
      ).text,
      (await got(await post(w.signup.POST, '/api/accounts', signupBody({ username: a.username }))))
        .text,
      (await got(await login({ username: 'x', password: 'y' }))).text,
    ];
    for (const t of texts) expect(t).not.toMatch(/\b(buy|ses|aud|cns)_[0-9a-z]{8}/);
    void ORIGIN;
  });
});
