// POB-P1: the publisher's own PayPal address and the terms click through. A publisher who claimed an account
// enters the email of their own PayPal Business account (requested); an operator with the second factor types
// it again in full to verify it; a change returns it to requested. Accepting the publisher terms writes an
// agreement record with the method publisher_accepted. UnitMarket never creates a PayPal account. PGlite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptTerms, ownAgreement } from './agreements';
import {
  decidePaypalLink,
  maskEmail,
  normalizePaypalEmail,
  ownPaypalLink,
  requestPaypalLink,
} from './paypal-link';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';
import type { LinkDeps } from './paypal-link';
import type { Actor, Database } from '@umsbx/contracts';

const HASH = 'scrypt:16384:8:1:00112233445566778899aabbccddeeff:' + 'a'.repeat(64);
let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});
const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await w.db.query<T>(sql, p)).rows;
let n = 0;
/** A new active publisher with a claimed account. */
async function withAccount(): Promise<{
  id: string;
  actor: Actor;
  username: string;
  /** A lower case address no other test publisher uses: one verified address belongs to one publisher (POB-LINKU). */
  email: string;
}> {
  n += 1;
  const id = `pub_link${String(n)}`;
  const username = `link.owner.${String(n)}`;
  const at = w.clock.now().toISOString();
  await w.db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'GB', 'active', $4, $4)`,
    [id, `link-pub-${String(n)}`, `Link Pub ${String(n)}`, at],
  );
  await w.db.query(
    `INSERT INTO publisher_accounts
       (publisher_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 0, NULL, $4, $4, $4)`,
    [id, username, HASH, at],
  );
  return {
    id,
    actor: { kind: 'publisher', publisher_id: id },
    username,
    email: `seller${String(n)}@example.com`,
  };
}
const MAIL = 'Seller@Example.com';
/** The same address typed with a capital first letter. */
const shout = (e: string): string => e.replace(/^./, (c) => c.toUpperCase());

describe('the email', () => {
  it('is trimmed and lower cased, one address, plain shape only', () => {
    expect(normalizePaypalEmail('  Seller@Example.com ')).toBe('seller@example.com');
    for (const bad of [
      '',
      'seller',
      'seller@',
      '@example.com',
      'seller@example',
      'a b@example.com',
      'a@b@example.com',
      '<x>@example.com',
      'seller@example.com\n',
      `${'a'.repeat(250)}@example.com`,
      'seller@exa mple.com',
    ])
      expect(normalizePaypalEmail(bad), bad).toBeNull();
  });
  it('is masked to its first letter and its domain for the audit and the operator list', () => {
    expect(maskEmail('seller@example.com')).toBe('s***@example.com');
  });
});

describe('POB-DEMOLINK: the synthetic demo link is flagged from data', () => {
  const put = async (id: string, email: string, by: string): Promise<void> => {
    const at = w.clock.now().toISOString();
    await w.db.query(
      `INSERT INTO publisher_paypal_links (publisher_id, paypal_email, state, verified_by, verified_at, created_at, updated_at)
       VALUES ($1, $2, 'verified', $3, $4, $4, $4)
       ON CONFLICT (publisher_id) DO UPDATE SET paypal_email = EXCLUDED.paypal_email, verified_by = EXCLUDED.verified_by,
         state = 'verified', verified_at = $4, updated_at = $4`,
      [id, email, by, at],
    );
  };
  it('ownPaypalLink: the seed marker or a .invalid address is synthetic, an operator check of a real address is not', async () => {
    const p = await withAccount();
    await put(p.id, 'demo-link-pub@payee.invalid', 'seed:synthetic');
    expect(await ownPaypalLink(w.db, p.actor)).toMatchObject({
      state: 'verified',
      synthetic: true,
    });
    await put(p.id, 'seller@example.com', 'opr_vikram');
    const real = (await ownPaypalLink(w.db, p.actor))!;
    expect(real.state).toBe('verified');
    expect(real.synthetic ?? false).toBe(false);
  });
});

describe('requestPaypalLink and ownPaypalLink', () => {
  it('stores the address as requested, shows it to its owner only, audits it masked', async () => {
    const p = await withAccount();
    const r = await requestPaypalLink(w.deps(), p.actor, { email: MAIL });
    expect(r).toEqual({ ok: true, value: { state: 'requested' } });
    const own = await ownPaypalLink(w.db, p.actor);
    expect(own).toMatchObject({
      email: 'seller@example.com',
      state: 'requested',
      verified_at: null,
    });
    const audits = await q<{ detail: unknown; action: string; reason: string | null }>(
      `SELECT action, detail, reason FROM audit_log WHERE target = $1 AND action LIKE 'publisher.paypal_link%'`,
      [p.id],
    );
    expect(audits.map((a) => a.action)).toEqual(['publisher.paypal_link_requested']);
    expect(JSON.stringify(audits)).not.toContain('seller@example.com');
    expect(JSON.stringify(audits)).toContain('s***@example.com');
    expect(await ownPaypalLink(w.db, w.harbour)).toBeNull();
    expect(await ownPaypalLink(w.db, w.buyer)).toBeNull();
    expect(await ownPaypalLink(w.db, w.operator)).toBeNull();
  });

  it('needs a claimed account: a demo publisher, a buyer and an operator are refused', async () => {
    expect(await requestPaypalLink(w.deps(), w.harbour, { email: MAIL })).toEqual({
      ok: false,
      error: { code: 'no_account' },
    });
    expect(await requestPaypalLink(w.deps(), w.buyer, { email: MAIL })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    expect(await requestPaypalLink(w.deps(), w.operator, { email: MAIL })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    expect(
      await q('SELECT 1 FROM publisher_paypal_links WHERE publisher_id = $1', [
        w.pubId['harbour-ledger'],
      ]),
    ).toEqual([]);
  });

  it('refuses a bad email and writes nothing', async () => {
    const p = await withAccount();
    for (const email of ['', 'nope', 'a b@c.de', '<a>@b.cd'])
      expect(await requestPaypalLink(w.deps(), p.actor, { email }), email).toEqual({
        ok: false,
        error: { code: 'invalid_email' },
      });
    expect(await ownPaypalLink(w.db, p.actor)).toBeNull();
  });

  it('a change returns a verified address to requested; the same address again changes nothing', async () => {
    const p = await withAccount();
    await requestPaypalLink(w.deps(), p.actor, { email: shout(p.email) });
    // asking again with the same address while it waits is a no-op
    expect(await requestPaypalLink(w.deps(), p.actor, { email: p.email })).toEqual({
      ok: true,
      value: { state: 'requested' },
    });
    const v = await decidePaypalLink(w.deps(), w.operator, {
      publisher_id: p.id,
      email_retyped: p.email,
      reason: 'Confirmed by phone',
    });
    expect(v).toEqual({ ok: true, value: { state: 'verified' } });
    expect(await requestPaypalLink(w.deps(), p.actor, { email: shout(p.email) })).toEqual({
      ok: false,
      error: { code: 'same_as_current' },
    });
    expect((await ownPaypalLink(w.db, p.actor))!.state).toBe('verified');
    expect(await requestPaypalLink(w.deps(), p.actor, { email: 'other@example.com' })).toEqual({
      ok: true,
      value: { state: 'requested' },
    });
    expect(await ownPaypalLink(w.db, p.actor)).toMatchObject({
      email: 'other@example.com',
      state: 'requested',
      verified_at: null,
    });
    const row = (
      await q<{ verified_by: unknown; verified_at: unknown }>(
        'SELECT verified_by, verified_at FROM publisher_paypal_links WHERE publisher_id = $1',
        [p.id],
      )
    )[0]!;
    expect(row).toEqual({ verified_by: null, verified_at: null });
  });
});

describe('decidePaypalLink', () => {
  it('verifies only when the operator types the whole address again', async () => {
    const p = await withAccount();
    await requestPaypalLink(w.deps(), p.actor, { email: shout(p.email) });
    const base = { publisher_id: p.id, reason: 'Confirmed by phone' };
    for (const email_retyped of [
      'seller@example.co',
      's***@example.com',
      '',
      'seller@example.com.',
    ])
      expect(
        await decidePaypalLink(w.deps(), w.operator, { ...base, email_retyped }),
        email_retyped,
      ).toEqual({
        ok: false,
        error: { code: 'email_mismatch' },
      });
    expect((await ownPaypalLink(w.db, p.actor))!.state).toBe('requested');
    w.clock.advance(1000);
    expect(
      await decidePaypalLink(w.deps(), w.operator, {
        ...base,
        email_retyped: ` ${p.email.toUpperCase()} `,
      }),
    ).toEqual({ ok: true, value: { state: 'verified' } });
    const own = (await ownPaypalLink(w.db, p.actor))!;
    expect(own.state).toBe('verified');
    expect(own.verified_at).toBe(w.clock.now().toISOString());
    expect(
      (
        await q<{ verified_by: string }>(
          'SELECT verified_by FROM publisher_paypal_links WHERE publisher_id = $1',
          [p.id],
        )
      )[0]!.verified_by,
    ).toBe('opr_vikram');
    const audits = await q<{ action: string; reason: string | null; detail: unknown }>(
      `SELECT action, reason, detail FROM audit_log WHERE target = $1 AND action = 'publisher.paypal_link_verified'`,
      [p.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe('Confirmed by phone');
    expect(JSON.stringify(audits)).not.toContain(p.email);
    // verified once
    expect(
      await decidePaypalLink(w.deps(), w.operator, {
        ...base,
        email_retyped: p.email,
      }),
    ).toEqual({ ok: false, error: { code: 'already_verified' } });
  });

  it('refuses a publisher, a buyer, an operator without the second factor, bad input and no request', async () => {
    const p = await withAccount();
    const a = { publisher_id: p.id, email_retyped: MAIL, reason: 'Confirmed by phone' };
    expect(await decidePaypalLink(w.deps(), p.actor, a)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await decidePaypalLink(w.deps(), w.buyer, a)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(
      await decidePaypalLink(w.deps(), { kind: 'operator', operator_id: 'opr_x', mfa: false }, a),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(await decidePaypalLink(w.deps(), w.operator, a)).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    await requestPaypalLink(w.deps(), p.actor, { email: MAIL });
    for (const bad of [{ reason: 'no' }, { reason: 'r'.repeat(201) }, { publisher_id: '' }])
      expect(await decidePaypalLink(w.deps(), w.operator, { ...a, ...bad })).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    expect((await ownPaypalLink(w.db, p.actor))!.state).toBe('requested');
  });
});

describe('acceptTerms', () => {
  it('writes a publisher_accepted record at the given version labelled with the username, once per version', async () => {
    const p = await withAccount();
    const r = await acceptTerms(w.deps(), p.actor, { terms_version: 'v1' });
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.terms_version).toBe('v1');
    const a = await ownAgreement(w.db, p.actor);
    expect(a).toMatchObject({
      publisher_id: p.id,
      terms_version: 'v1',
      method: 'publisher_accepted',
      accepted_by_label: p.username,
      accepted_at: w.clock.now().toISOString(),
    });
    expect(await acceptTerms(w.deps(), p.actor, { terms_version: 'v1' })).toEqual({
      ok: false,
      error: { code: 'already_accepted' },
    });
    // a later version is a new row and the old one stays
    w.clock.advance(1000);
    expect((await acceptTerms(w.deps(), p.actor, { terms_version: 'v2' })).ok).toBe(true);
    expect((await ownAgreement(w.db, p.actor))!.terms_version).toBe('v2');
    expect(
      await q('SELECT 1 FROM publisher_agreements WHERE publisher_id = $1', [p.id]),
    ).toHaveLength(2);
    expect(
      (await q<{ action: string }>(`SELECT action FROM audit_log WHERE target = $1`, [p.id])).map(
        (x) => x.action,
      ),
    ).toContain('publisher.terms_accepted');
  });

  it('needs a claimed account and a publisher; bad versions are refused', async () => {
    expect(await acceptTerms(w.deps(), w.harbour, { terms_version: 'v1' })).toEqual({
      ok: false,
      error: { code: 'no_account' },
    });
    expect(await acceptTerms(w.deps(), w.buyer, { terms_version: 'v1' })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    expect(await acceptTerms(w.deps(), w.operator, { terms_version: 'v1' })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    const p = await withAccount();
    for (const terms_version of ['', '  ', 'v'.repeat(41)])
      expect(await acceptTerms(w.deps(), p.actor, { terms_version })).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    expect(await ownAgreement(w.db, p.actor)).toBeNull();
  });
});

// POB-G (gap 3): a verified PayPal link makes the publisher buyable in dry run. The buy path (approval, place)
// needs publishers.paypal_merchant_id and payee_verified_at; the boot seed only reaches publishers that exist at boot.
describe('the verified link makes the publisher buyable (dry run only)', () => {
  const payee = async (id: string) =>
    (
      await q<{ paypal_merchant_id: string | null; payee_verified_at: unknown; synthetic: string }>(
        `SELECT paypal_merchant_id, payee_verified_at, 'DRYRUN' || upper(left(md5(slug), 7)) AS synthetic
           FROM publishers WHERE id = $1`,
        [id],
      )
    )[0]!;
  const dry = () => ({ ...w.deps(), environment: 'dryrun' as const });
  const sbx = () => ({ ...w.deps(), environment: 'sandbox' as const });
  const verify = (deps: LinkDeps, p: { id: string; email: string }, email = p.email) =>
    decidePaypalLink(deps, w.operator, {
      publisher_id: p.id,
      email_retyped: email,
      reason: 'Confirmed by phone',
    });

  it('dry run: verifying sets payee_verified_at and the synthetic payee, in the same step as the link', async () => {
    const p = await withAccount();
    await requestPaypalLink(dry(), p.actor, { email: p.email });
    const before = await payee(p.id);
    expect(before.paypal_merchant_id).toBeNull();
    expect(before.payee_verified_at).toBeNull();
    // a wrong retype changes nothing
    await verify(dry(), p, 'wrong@example.com');
    expect((await payee(p.id)).payee_verified_at).toBeNull();
    w.clock.advance(1000);
    expect(await verify(dry(), p)).toEqual({ ok: true, value: { state: 'verified' } });
    const after = await payee(p.id);
    expect(after.paypal_merchant_id).toBe(after.synthetic);
    expect(new Date(after.payee_verified_at as string).toISOString()).toBe(
      w.clock.now().toISOString(),
    );
  });

  it('dry run: a merchant id the publisher already has is kept; only the verification is set', async () => {
    const p = await withAccount();
    await w.db.query(`UPDATE publishers SET paypal_merchant_id = 'KEPT123' WHERE id = $1`, [p.id]);
    await requestPaypalLink(dry(), p.actor, { email: p.email });
    await verify(dry(), p);
    const after = await payee(p.id);
    expect(after.paypal_merchant_id).toBe('KEPT123');
    expect(after.payee_verified_at).not.toBeNull();
  });

  it('sandbox: no merchant id is invented and the payee is not marked verified (the existing checks stay)', async () => {
    const p = await withAccount();
    await requestPaypalLink(sbx(), p.actor, { email: p.email });
    expect(await verify(sbx(), p)).toEqual({ ok: true, value: { state: 'verified' } });
    const after = await payee(p.id);
    expect(after.paypal_merchant_id).toBeNull();
    expect(after.payee_verified_at).toBeNull();
    expect((await ownPaypalLink(w.db, p.actor))!.state).toBe('verified');
  });

  it('dry run: a changed address clears the verification again; the next check sets it', async () => {
    const p = await withAccount();
    await requestPaypalLink(dry(), p.actor, { email: p.email });
    await verify(dry(), p);
    expect((await payee(p.id)).payee_verified_at).not.toBeNull();
    // the same address again is refused and changes nothing
    await requestPaypalLink(dry(), p.actor, { email: p.email });
    expect((await payee(p.id)).payee_verified_at).not.toBeNull();
    await requestPaypalLink(dry(), p.actor, { email: 'other@example.com' });
    const cleared = await payee(p.id);
    expect(cleared.payee_verified_at).toBeNull();
    expect(cleared.paypal_merchant_id).toBe(cleared.synthetic); // the label stays, it is not an account
    w.clock.advance(1000);
    await verify(dry(), p, 'other@example.com');
    expect((await payee(p.id)).payee_verified_at).not.toBeNull();
  });

  it('sandbox: a changed address does not touch the payee columns', async () => {
    const p = await withAccount();
    await w.db.query(
      `UPDATE publishers SET paypal_merchant_id = 'SBXOWN01', payee_verified_at = $2 WHERE id = $1`,
      [p.id, w.clock.now().toISOString()],
    );
    await requestPaypalLink(sbx(), p.actor, { email: p.email });
    await verify(sbx(), p);
    await requestPaypalLink(sbx(), p.actor, { email: 'other@example.com' });
    const after = await payee(p.id);
    expect(after.paypal_merchant_id).toBe('SBXOWN01');
    expect(after.payee_verified_at).not.toBeNull();
  });
});

// POB-LINKU: one verified address belongs to one publisher. A request proves nothing, so several publishers may
// ask for the same address; the refusal is the operator's verification, and the database repeats it.
describe('one verified address belongs to one publisher', () => {
  const verify = (p: { id: string }, email: string) =>
    decidePaypalLink(w.deps(), w.operator, {
      publisher_id: p.id,
      email_retyped: email,
      reason: 'Confirmed by phone',
    });
  const state = async (p: { id: string }) =>
    (
      await q<{ state: string; verified_by: unknown; verified_at: unknown }>(
        'SELECT state, verified_by, verified_at FROM publisher_paypal_links WHERE publisher_id = $1',
        [p.id],
      )
    )[0]!;
  const verifiedAudits = async (p: { id: string }) =>
    await q(
      `SELECT 1 FROM audit_log WHERE target = $1 AND action = 'publisher.paypal_link_verified'`,
      [p.id],
    );
  const SHARED_ERR = { ok: false, error: { code: 'email_in_use' } };

  it('allows several requested links with one address, spelled in any case or with spaces', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const c = await withAccount();
    const shared = `shared.request.${String(n)}@example.com`;
    for (const [p, typed] of [
      [a, shared],
      [b, ` ${shared.toUpperCase()} `],
      [c, shout(shared)],
    ] as const)
      expect(await requestPaypalLink(w.deps(), p.actor, { email: typed })).toEqual({
        ok: true,
        value: { state: 'requested' },
      });
    for (const p of [a, b, c])
      expect(await ownPaypalLink(w.db, p.actor)).toMatchObject({
        email: shared,
        state: 'requested',
      });
  });

  it('allows two different addresses to be verified for two publishers', async () => {
    const a = await withAccount();
    const b = await withAccount();
    await requestPaypalLink(w.deps(), a.actor, { email: a.email });
    await requestPaypalLink(w.deps(), b.actor, { email: b.email });
    expect(await verify(a, a.email)).toEqual({ ok: true, value: { state: 'verified' } });
    expect(await verify(b, b.email)).toEqual({ ok: true, value: { state: 'verified' } });
  });

  it('refuses the second verification of an address, tells the publisher nothing and changes nothing', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const mail = `taken.${String(n)}@example.com`;
    await requestPaypalLink(w.deps(), a.actor, { email: mail });
    expect(await verify(a, mail)).toEqual({ ok: true, value: { state: 'verified' } });
    // no existence leak: B's request answers exactly as any other request does
    expect(await requestPaypalLink(w.deps(), b.actor, { email: mail })).toEqual({
      ok: true,
      value: { state: 'requested' },
    });
    expect(await ownPaypalLink(w.db, b.actor)).toMatchObject({ email: mail, state: 'requested' });
    const before = await state(b);
    const audits = await q('SELECT 1 FROM audit_log');
    w.clock.advance(1000);
    expect(await verify(b, mail)).toEqual(SHARED_ERR);
    expect(await state(b)).toEqual(before);
    expect(before).toEqual({ state: 'requested', verified_by: null, verified_at: null });
    expect(await verifiedAudits(b)).toEqual([]);
    expect(await q('SELECT 1 FROM audit_log')).toHaveLength(audits.length);
    // A is untouched
    expect((await state(a)).state).toBe('verified');
  });

  it('treats case and whitespace variants as the same address', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const mail = `variant.${String(n)}@example.com`;
    await requestPaypalLink(w.deps(), a.actor, { email: mail });
    await verify(a, mail);
    await requestPaypalLink(w.deps(), b.actor, { email: `  ${mail.toUpperCase()}  ` });
    expect(await verify(b, ` ${shout(mail)} `)).toEqual(SHARED_ERR);
    expect((await state(b)).state).toBe('requested');
  });

  it('in dry run a refused verification leaves the publisher unbuyable', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const mail = `dry.${String(n)}@example.com`;
    const dry = { ...w.deps(), environment: 'dryrun' as const };
    await requestPaypalLink(dry, a.actor, { email: mail });
    await decidePaypalLink(dry, w.operator, {
      publisher_id: a.id,
      email_retyped: mail,
      reason: 'Confirmed by phone',
    });
    await requestPaypalLink(dry, b.actor, { email: mail });
    expect(
      await decidePaypalLink(dry, w.operator, {
        publisher_id: b.id,
        email_retyped: mail,
        reason: 'Confirmed by phone',
      }),
    ).toEqual(SHARED_ERR);
    expect(
      (
        await q<{ paypal_merchant_id: string | null; payee_verified_at: unknown }>(
          'SELECT paypal_merchant_id, payee_verified_at FROM publishers WHERE id = $1',
          [b.id],
        )
      )[0],
    ).toEqual({ paypal_merchant_id: null, payee_verified_at: null });
  });

  it('lets the same publisher change the address and verify it again, and frees the old address', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const x = `own.x.${String(n)}@example.com`;
    const y = `own.y.${String(n)}@example.com`;
    await requestPaypalLink(w.deps(), a.actor, { email: x });
    expect(await verify(a, x)).toEqual({ ok: true, value: { state: 'verified' } });
    // A moves to Y: X is free for B, and B can be verified on it
    await requestPaypalLink(w.deps(), a.actor, { email: y });
    await requestPaypalLink(w.deps(), b.actor, { email: x });
    expect(await verify(b, x)).toEqual({ ok: true, value: { state: 'verified' } });
    expect(await verify(a, y)).toEqual({ ok: true, value: { state: 'verified' } });
    // A asks for X again: it may ask, but the operator cannot verify it while B holds it
    await requestPaypalLink(w.deps(), a.actor, { email: x });
    expect(await verify(a, x)).toEqual(SHARED_ERR);
    // B moves away, then A may be verified on X
    await requestPaypalLink(w.deps(), b.actor, { email: b.email });
    expect(await verify(a, x)).toEqual({ ok: true, value: { state: 'verified' } });
  });

  it('pins the pre-check: the refusal comes before any write, so the index never has to raise 23505', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const mail = `precheck.${String(n)}@example.com`;
    await requestPaypalLink(w.deps(), a.actor, { email: mail });
    await verify(a, mail);
    await requestPaypalLink(w.deps(), b.actor, { email: mail });
    const raised: unknown[] = [];
    const db: Database = {
      dialect: w.db.dialect,
      query: (sql, params) => w.db.query(sql, params),
      exec: (sql) => w.db.exec(sql),
      transaction: (fn) =>
        w.db.transaction((tx) =>
          fn({
            exec: (sql) => tx.exec(sql),
            query: async (sql, params) => {
              try {
                return await tx.query(sql, params);
              } catch (e) {
                raised.push(e);
                throw e;
              }
            },
          }),
        ),
    };
    expect(
      await decidePaypalLink({ ...w.deps(), db }, w.operator, {
        publisher_id: b.id,
        email_retyped: mail,
        reason: 'Confirmed by phone',
      }),
    ).toEqual(SHARED_ERR);
    expect(raised).toEqual([]);
  });

  it('is enforced by the database: a second verified row for one address fails with 23505', async () => {
    const a = await withAccount();
    const b = await withAccount();
    const mail = `index.${String(n)}@example.com`;
    await requestPaypalLink(w.deps(), a.actor, { email: mail });
    await verify(a, mail);
    await requestPaypalLink(w.deps(), b.actor, { email: mail });
    const at = w.clock.now().toISOString();
    const forceVerified = (email: string) =>
      w.db.query(
        `UPDATE publisher_paypal_links
            SET paypal_email = $2, state = 'verified', verified_by = 'opr_sql', verified_at = $3
          WHERE publisher_id = $1`,
        [b.id, email, at],
      );
    for (const spelled of [mail, mail.toUpperCase(), ` ${mail} `])
      await expect(forceVerified(spelled), spelled).rejects.toMatchObject({ code: '23505' });
    expect((await state(b)).state).toBe('requested');
    // a requested row with the same address is fine for the database too
    expect(
      await q('SELECT 1 FROM publisher_paypal_links WHERE paypal_email = $1', [mail]),
    ).toHaveLength(2);
  });
});
