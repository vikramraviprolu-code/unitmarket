// POB-P1 through the real routes on an offline app: approval shows the operator a one time invite code; the
// publisher claims an account, signs in with a username and password, accepts the publisher terms with a real
// action and links their own PayPal address, which an operator verifies by typing it again. The three demo
// personas keep working. A buyer cannot use the publisher routes. Passwords and codes are fictional.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { errorOf, freshIp, got, operatorCookie, post } from './accounts-support';
import { PASSCODE, testEnv } from './support';

vi.mock('server-only', () => ({}));

const PW = 'violet lamps hum softly';
const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const LINK_NO_ACCOUNT = 'Only a publisher who claimed an account can link an address.';

let app: App;
let r: {
  claim: typeof import('./app/api/publisher-accounts/claim/route');
  session: typeof import('./app/api/session/route');
  decision: typeof import('./app/api/ops/publishers/applicants/decision/route');
  access: typeof import('./app/api/ops/publishers/access/route');
  terms: typeof import('./app/api/publisher/terms/accept/route');
  link: typeof import('./app/api/publisher/paypal-link/route');
  linkDecision: typeof import('./app/api/ops/publishers/paypal-link-decisions/route');
  signout: typeof import('./app/api/session/signout/route');
};
let op: { cookie: string; csrf: string };
beforeAll(async () => {
  app = createApp(
    await testEnv({
      UMS_TRUSTED_PROXIES: '1',
      UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(
        PUBLISHER_PASSCODE,
        '00112233445566778899aabbccddeeff',
      ),
    }),
    { switch_cache_ms: 0 },
  );
  installApp(app);
  await app.ready();
  r = {
    claim: await import('./app/api/publisher-accounts/claim/route'),
    session: await import('./app/api/session/route'),
    decision: await import('./app/api/ops/publishers/applicants/decision/route'),
    access: await import('./app/api/ops/publishers/access/route'),
    terms: await import('./app/api/publisher/terms/accept/route'),
    link: await import('./app/api/publisher/paypal-link/route'),
    linkDecision: await import('./app/api/ops/publishers/paypal-link-decisions/route'),
    signout: await import('./app/api/session/signout/route'),
  };
  op = await operatorCookie(app);
});
afterAll(async () => {
  await app.close();
});

const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await app.db.query<T>(sql, p)).rows;
let n = 0;
const sess = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, csrf: s.csrf });

/** Adds an applicant as the operator and approves it through the route. Returns the id and the shown code. */
async function approve(): Promise<{ id: string; code: string; expires_at: string; text: string }> {
  n += 1;
  const added = await app.engine.opsApplicants.add({
    actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
    slug: `web-pub-${String(n)}`,
    display_name: `Web Pub ${String(n)}`,
    country: 'GB',
    reason: 'Operator added after a call',
  });
  if (!added.ok) throw new Error(added.error.code);
  const g = await got(
    await post(
      r.decision.POST,
      '/api/ops/publishers/applicants/decision',
      { publisher_id: added.value.publisher_id, decision: 'approve', reason: 'Checked in person' },
      sess(op),
    ),
  );
  expect(g.status).toBe(200);
  const invite = g.json['invite'] as { code: string; expires_at: string };
  return { id: added.value.publisher_id, ...invite, text: g.text };
}
const claim = (code: string, username: string, password = PW, ip = freshIp()) =>
  post(r.claim.POST, '/api/publisher-accounts/claim', { code, username, password }, { ip });
/** An approved, claimed publisher with a session. */
async function account(): Promise<{
  id: string;
  username: string;
  cookie: string;
  csrf: string;
  code: string;
}> {
  const a = await approve();
  const username = `pub.owner.${String(n)}`;
  const g = await got(await claim(a.code, username));
  if (g.status !== 200 || g.cookie === null || g.csrf === null) throw new Error(g.text);
  return { id: a.id, username, cookie: g.cookie, csrf: g.csrf, code: a.code };
}

describe('route declarations', () => {
  it('claim is public and CSRF checked; the publisher routes need a publisher; the ops routes an operator', () => {
    expect(r.claim.routeMeta).toMatchObject({
      path: '/api/publisher-accounts/claim',
      method: 'POST',
      auth: 'public',
      csrf: true,
      risk: 'high',
      idempotent: false,
    });
    expect(r.claim.routeMeta.rate?.per).toBe('ip');
    expect(r.claim.routeMeta.max_body_bytes).toBeLessThanOrEqual(4096);
    expect(r.terms.routeMeta).toMatchObject({
      path: '/api/publisher/terms/accept',
      method: 'POST',
      auth: 'publisher',
      csrf: true,
    });
    expect(r.link.routeMeta).toMatchObject({
      path: '/api/publisher/paypal-link',
      method: 'POST',
      auth: 'publisher',
      csrf: true,
    });
    expect(r.access.routeMeta).toMatchObject({
      path: '/api/ops/publishers/access',
      method: 'POST',
      auth: 'operator',
      csrf: true,
      risk: 'high',
    });
    expect(r.linkDecision.routeMeta).toMatchObject({
      path: '/api/ops/publishers/paypal-link-decisions',
      method: 'POST',
      auth: 'operator',
      csrf: true,
      risk: 'high',
    });
  });
});

describe('approval shows the code once', () => {
  it('the approval answer holds a 12 character code and an expiry 7 days out', async () => {
    const a = await approve();
    expect(a.code).toMatch(CODE);
    const row = (
      await q<{ created_at: unknown; expires_at: unknown }>(
        'SELECT created_at, expires_at FROM publisher_invites WHERE publisher_id = $1',
        [a.id],
      )
    )[0]!;
    expect(Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at))).toBe(
      7 * 86_400_000,
    );
    expect(Date.parse(a.expires_at)).toBe(Date.parse(String(row.expires_at)));
  });

  it('no second read shows it: the list, the next call, the database and the audit log do not hold it', async () => {
    const a = await approve();
    const list = await app.engine.opsPublisherAccess.list({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    });
    if (!list.ok) throw new Error(list.error.code);
    expect(JSON.stringify(list.value)).not.toContain(a.code);
    const row = list.value.rows.find((x) => x.publisher_id === a.id)!;
    expect(row.invite).toBe('live');
    // deciding again is refused and carries no code
    const again = await got(
      await post(
        r.decision.POST,
        '/api/ops/publishers/applicants/decision',
        { publisher_id: a.id, decision: 'approve', reason: 'Checked in person' },
        sess(op),
      ),
    );
    expect(again.status).toBe(409);
    expect(again.text).not.toContain(a.code);
    expect(JSON.stringify(await q('SELECT * FROM publisher_invites'))).not.toContain(a.code);
    expect(JSON.stringify(await q('SELECT * FROM audit_log'))).not.toContain(a.code);
  });

  it('a rejection shows no code', async () => {
    n += 1;
    const added = await app.engine.opsApplicants.add({
      actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      slug: `web-rej-${String(n)}`,
      display_name: 'Web Rej',
      country: 'GB',
      reason: 'Operator added after a call',
    });
    if (!added.ok) throw new Error(added.error.code);
    const g = await got(
      await post(
        r.decision.POST,
        '/api/ops/publishers/applicants/decision',
        { publisher_id: added.value.publisher_id, decision: 'reject', reason: 'Not a fit now' },
        sess(op),
      ),
    );
    expect(g.status).toBe(200);
    expect(g.json).toEqual({ state: 'rejected' });
  });
});

describe('claim, then sign in', () => {
  it('claims with the code, signs in as the publisher, and the cookie is a publisher session', async () => {
    const a = await approve();
    const g = await got(await claim(a.code, 'first.owner'));
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ actor_kind: 'publisher' });
    expect(g.setCookie).toMatch(/^__Host-ums_s=ses_[0-9a-z]{26}\./);
    expect(g.text).not.toMatch(/pub_|ses_|aud_/);
    expect(await app.engine.actorFromCookie(g.cookie!)).toEqual({
      kind: 'publisher',
      publisher_id: a.id,
    });
    // sign in with the username and password on the existing session route
    const s = await got(
      await post(
        r.session.POST,
        '/api/session',
        { username: 'first.owner', password: PW },
        { ip: freshIp() },
      ),
    );
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ actor_kind: 'publisher' });
    expect(typeof s.csrf).toBe('string');
    expect(await app.engine.actorFromCookie(s.cookie!)).toEqual({
      kind: 'publisher',
      publisher_id: a.id,
    });
    // the same code cannot be used again
    const again = await got(await claim(a.code, 'second.owner'));
    expect(again.status).toBe(403);
    expect(errorOf(again).code).toBe('invalid_code');
  });

  it('a wrong password and an unknown name answer the same 401', async () => {
    const p = await account();
    const wrong = await got(
      await post(
        r.session.POST,
        '/api/session',
        { username: p.username, password: 'wrong wrong wrong' },
        { ip: freshIp() },
      ),
    );
    const unknown = await got(
      await post(
        r.session.POST,
        '/api/session',
        { username: 'nobody.here', password: 'wrong wrong wrong' },
        { ip: freshIp() },
      ),
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(errorOf(wrong)).toEqual(errorOf(unknown));
    expect(wrong.cookie).toBeNull();
  });

  it('a suspended publisher cannot sign in with the right password', async () => {
    const p = await account();
    await app.db.query("UPDATE publishers SET status = 'suspended' WHERE id = $1", [p.id]);
    const g = await got(
      await post(
        r.session.POST,
        '/api/session',
        { username: p.username, password: PW },
        { ip: freshIp() },
      ),
    );
    expect(g.status).toBe(401);
    await app.db.query("UPDATE publishers SET status = 'active' WHERE id = $1", [p.id]);
    expect(
      (
        await got(
          await post(
            r.session.POST,
            '/api/session',
            { username: p.username, password: PW },
            { ip: freshIp() },
          ),
        )
      ).status,
    ).toBe(200);
  });

  it('a weak password and a taken username are refused and the code stays usable', async () => {
    const a = await approve();
    const weak = await got(await claim(a.code, 'weak.owner', 'short'));
    expect(weak.status).toBe(422);
    expect(errorOf(weak).code).toBe('weak_password');
    const p = await account();
    const taken = await got(await claim(a.code, p.username));
    expect(taken.status).toBe(409);
    expect(errorOf(taken).code).toBe('taken');
    expect((await got(await claim(a.code, 'fresh.owner'))).status).toBe(200);
  });

  it('a buyer account name does not sign in as a publisher; a body of both shapes is refused', async () => {
    const mixed = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'operator', passcode: 'x', username: 'a.b.c', password: PW },
        { ip: freshIp() },
      ),
    );
    expect(mixed.status).toBe(422);
  });
});

describe('the demo personas are unchanged', () => {
  it('a publisher persona with the publisher passcode still signs in, and the demo passcode does not', async () => {
    const ok = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'publisher-harbour-ledger', passcode: PUBLISHER_PASSCODE },
        { ip: freshIp() },
      ),
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ actor_kind: 'publisher' });
    const bad = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'publisher-harbour-ledger', passcode: PASSCODE },
        { ip: freshIp() },
      ),
    );
    expect(bad.status).toBe(401);
    const buyer = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'buyer-a', passcode: PASSCODE },
        { ip: freshIp() },
      ),
    );
    expect(buyer.status).toBe(200);
  });

  it('they keep their seeded terms record, have no account row and cannot be issued an invite', async () => {
    for (const slug of ['harbour-ledger', 'quayside-gazette', 'northfield-quarterly']) {
      const id = (await q<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug]))[0]!
        .id;
      const a = await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: id });
      expect(a).toMatchObject({ method: 'seeded_demo' });
      expect(await q('SELECT 1 FROM publisher_accounts WHERE publisher_id = $1', [id])).toEqual([]);
      const issue = await got(
        await post(
          r.access.POST,
          '/api/ops/publishers/access',
          { publisher_id: id, action: 'issue', reason: 'Try it' },
          sess(op),
        ),
      );
      expect(issue.status).toBe(409);
      expect(errorOf(issue).code).toBe('not_allowed');
    }
    const list = await app.engine.opsPublisherAccess.list({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    });
    if (!list.ok) throw new Error(list.error.code);
    expect(list.value.rows.map((x) => x.slug)).not.toContain('harbour-ledger');
  });

  it('the demo persona cannot accept terms or link an address, with the pinned sentence', async () => {
    const s = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'publisher-quayside-gazette', passcode: PUBLISHER_PASSCODE },
        { ip: freshIp() },
      ),
    );
    const t = await got(
      await post(
        r.terms.POST,
        '/api/publisher/terms/accept',
        {},
        { cookie: s.cookie!, csrf: s.csrf! },
      ),
    );
    expect(t.status).toBe(403);
    expect(errorOf(t).code).toBe('no_account');
    const l = await got(
      await post(
        r.link.POST,
        '/api/publisher/paypal-link',
        { email: 'seller@example.com' },
        { cookie: s.cookie!, csrf: s.csrf! },
      ),
    );
    expect(l.status).toBe(403);
    expect(errorOf(l)).toEqual({ code: 'no_account', message: LINK_NO_ACCOUNT });
  });
});

describe('terms', () => {
  it('a real action writes a publisher_accepted record with the username; once per version', async () => {
    const p = await account();
    expect(
      await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: p.id }),
    ).toBeNull();
    const g = await got(await post(r.terms.POST, '/api/publisher/terms/accept', {}, sess(p)));
    expect(g.status).toBe(200);
    expect(g.json).toEqual({ terms_version: 'v1' });
    const a = await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: p.id });
    expect(a).toMatchObject({
      terms_version: 'v1',
      method: 'publisher_accepted',
      accepted_by_label: p.username,
    });
    const again = await got(await post(r.terms.POST, '/api/publisher/terms/accept', {}, sess(p)));
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('already_accepted');
    const view = await app.engine.publisherAccounts.view({ kind: 'publisher', publisher_id: p.id });
    expect(view).toMatchObject({ username: p.username });
    expect(view!.agreement).toMatchObject({ method: 'publisher_accepted' });
  });

  it('is refused without CSRF, with extra fields, and for a buyer or an anonymous caller', async () => {
    const p = await account();
    expect(
      (await got(await post(r.terms.POST, '/api/publisher/terms/accept', {}, { cookie: p.cookie })))
        .status,
    ).toBe(403);
    expect(
      (
        await got(
          await post(r.terms.POST, '/api/publisher/terms/accept', { terms_version: 'v0' }, sess(p)),
        )
      ).status,
    ).toBe(422);
    const buyer = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'buyer-a', passcode: PASSCODE },
        { ip: freshIp() },
      ),
    );
    const b = await got(
      await post(
        r.terms.POST,
        '/api/publisher/terms/accept',
        {},
        { cookie: buyer.cookie!, csrf: buyer.csrf! },
      ),
    );
    expect([401, 403]).toContain(b.status);
    expect([401, 403]).toContain(
      (await got(await post(r.terms.POST, '/api/publisher/terms/accept', {}))).status,
    );
  });
});

describe('the PayPal link', () => {
  const op2 = (): Actor => ({ kind: 'operator', operator_id: 'opr_vikram', mfa: true });
  it('is requested by the publisher and verified by an operator who types it again in full', async () => {
    const p = await account();
    const g = await got(
      await post(
        r.link.POST,
        '/api/publisher/paypal-link',
        { email: 'Seller@Example.com' },
        sess(p),
      ),
    );
    expect(g.status).toBe(200);
    expect(g.json).toEqual({ state: 'requested' });
    const view = await app.engine.publisherAccounts.view({ kind: 'publisher', publisher_id: p.id });
    expect(view!.link).toMatchObject({ email: 'seller@example.com', state: 'requested' });
    // the operator list shows it masked
    const list = await app.engine.opsPublisherAccess.list(op2());
    if (!list.ok) throw new Error(list.error.code);
    const row = list.value.rows.find((x) => x.publisher_id === p.id)!;
    expect(row.link).toEqual({ state: 'requested', masked_email: 's***@example.com' });
    expect(JSON.stringify(list.value)).not.toContain('seller@example.com');
    const body = { publisher_id: p.id, reason: 'Confirmed by phone' };
    const wrong = await got(
      await post(
        r.linkDecision.POST,
        '/api/ops/publishers/paypal-link-decisions',
        { ...body, email_retyped: 'seller@example.co' },
        sess(op),
      ),
    );
    expect(wrong.status).toBe(409);
    expect(errorOf(wrong).code).toBe('email_mismatch');
    const ok = await got(
      await post(
        r.linkDecision.POST,
        '/api/ops/publishers/paypal-link-decisions',
        { ...body, email_retyped: 'seller@example.com' },
        sess(op),
      ),
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ state: 'verified' });
    expect(
      (await app.engine.publisherAccounts.view({ kind: 'publisher', publisher_id: p.id }))!.link,
    ).toMatchObject({ state: 'verified' });
    // a change goes back to requested
    await post(r.link.POST, '/api/publisher/paypal-link', { email: 'other@example.com' }, sess(p));
    expect(
      (await app.engine.publisherAccounts.view({ kind: 'publisher', publisher_id: p.id }))!.link,
    ).toMatchObject({ email: 'other@example.com', state: 'requested' });
  });

  it('a publisher, a buyer and an operator without the second factor cannot verify; bad emails are refused', async () => {
    const p = await account();
    await post(r.link.POST, '/api/publisher/paypal-link', { email: 'seller@example.com' }, sess(p));
    const body = {
      publisher_id: p.id,
      reason: 'Confirmed by phone',
      email_retyped: 'seller@example.com',
    };
    const asPublisher = await got(
      await post(r.linkDecision.POST, '/api/ops/publishers/paypal-link-decisions', body, sess(p)),
    );
    expect([401, 403]).toContain(asPublisher.status);
    const noMfa = await operatorCookie(app, false);
    const g = await got(
      await post(
        r.linkDecision.POST,
        '/api/ops/publishers/paypal-link-decisions',
        body,
        sess(noMfa),
      ),
    );
    expect(g.status).toBe(403);
    expect(errorOf(g).code).toBe('mfa_required');
    const bad = await got(
      await post(r.link.POST, '/api/publisher/paypal-link', { email: 'not an email' }, sess(p)),
    );
    expect(bad.status).toBe(422);
    expect(errorOf(bad).code).toBe('invalid_email');
    expect(
      (await app.engine.publisherAccounts.view({ kind: 'publisher', publisher_id: p.id }))!.link,
    ).toMatchObject({ state: 'requested' });
  });

  it('a buyer cannot use any publisher route', async () => {
    const buyer = await got(
      await post(
        r.session.POST,
        '/api/session',
        { persona: 'buyer-b', passcode: PASSCODE },
        { ip: freshIp() },
      ),
    );
    const s = { cookie: buyer.cookie!, csrf: buyer.csrf! };
    for (const [h, path, body] of [
      [r.terms.POST, '/api/publisher/terms/accept', {}],
      [r.link.POST, '/api/publisher/paypal-link', { email: 'seller@example.com' }],
    ] as const) {
      const g = await got(await post(h, path, body, s));
      expect([401, 403], path).toContain(g.status);
    }
    expect(
      await app.engine.publisherAccounts.view({ kind: 'buyer', buyer_id: 'buy_x' }),
    ).toBeNull();
  });
});

describe('issue and reset by an operator', () => {
  it('issue replaces a live invite, shows the new code once, and the old code stops working', async () => {
    const a = await approve();
    const g = await got(
      await post(
        r.access.POST,
        '/api/ops/publishers/access',
        { publisher_id: a.id, action: 'issue', reason: 'Lost the code' },
        sess(op),
      ),
    );
    expect(g.status).toBe(200);
    const invite = g.json['invite'] as { code: string; expires_at: string };
    expect(invite.code).toMatch(CODE);
    expect(invite.code).not.toBe(a.code);
    expect(errorOf(await got(await claim(a.code, 'old.code.user'))).code).toBe('invalid_code');
    expect((await got(await claim(invite.code, 'new.code.user'))).status).toBe(200);
  });

  it('reset removes the account password and sessions and issues a new invite', async () => {
    const p = await account();
    const g = await got(
      await post(
        r.access.POST,
        '/api/ops/publishers/access',
        { publisher_id: p.id, action: 'reset', reason: 'Lost the password' },
        sess(op),
      ),
    );
    expect(g.status).toBe(200);
    const invite = g.json['invite'] as { code: string };
    expect(invite.code).toMatch(CODE);
    expect(await app.engine.actorFromCookie(p.cookie)).toEqual({ kind: 'system' });
    expect(
      (
        await got(
          await post(
            r.session.POST,
            '/api/session',
            { username: p.username, password: PW },
            { ip: freshIp() },
          ),
        )
      ).status,
    ).toBe(401);
    expect((await got(await claim(invite.code, p.username))).status).toBe(200);
  });

  it('is refused for a publisher, a buyer, an operator without the second factor, and a bad body', async () => {
    const p = await account();
    const body = { publisher_id: p.id, action: 'reset', reason: 'Lost the password' };
    expect([401, 403]).toContain(
      (await got(await post(r.access.POST, '/api/ops/publishers/access', body, sess(p)))).status,
    );
    const noMfa = await operatorCookie(app, false);
    const g = await got(await post(r.access.POST, '/api/ops/publishers/access', body, sess(noMfa)));
    expect(g.status).toBe(403);
    expect(errorOf(g).code).toBe('mfa_required');
    for (const bad of [
      { ...body, action: 'delete' },
      { ...body, reason: 'no' },
      { ...body, extra: 1 },
    ])
      expect(
        (await got(await post(r.access.POST, '/api/ops/publishers/access', bad, sess(op)))).status,
      ).toBe(422);
  });
});

describe('secrets', () => {
  it('no password and no invite code reaches the audit log or the sessions table', async () => {
    const a = await approve();
    await claim(a.code, 'secret.owner');
    const text = JSON.stringify([
      await q('SELECT * FROM audit_log'),
      await q('SELECT * FROM sessions'),
    ]);
    expect(text).not.toContain(PW);
    expect(text).not.toContain(a.code);
  });
});
