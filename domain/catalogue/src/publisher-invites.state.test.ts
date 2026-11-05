// POB-P1 (docs/specs/pob-p1-publisher-accounts.md): the invite code of a new publisher. Approving an
// applicant shows the operator a one time code; an operator can issue, replace it, or reset the sign in of a
// publisher. Only a SHA-256 hash is stored and no audit row holds the code. The three demo publishers are never
// issued an invite, whatever rows they have. PGlite with the base seed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addApplicant, decideApplicant } from './applicants';
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_TTL_MS,
  hashInviteCode,
  inviteCodeFromNonce,
  issueInvite,
  listPublisherAccess,
  normalizeInviteCode,
  resetPublisherSignIn,
} from './publisher-invites';
import type { InviteDeps } from './publisher-invites';
import { setPublisherStatus } from './status';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

const DEMO = ['harbour-ledger', 'quayside-gazette', 'northfield-quarterly'] as const;
const HASH = 'scrypt:16384:8:1:00112233445566778899aabbccddeeff:' + 'a'.repeat(64);
const DAY = 86_400_000;

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});
const deps = (): InviteDeps => ({ ...w.deps(), demo_slugs: DEMO });
const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await w.db.query<T>(sql, p)).rows;
let n = 0;
/** A fresh applicant, approved: returns its id and the invite code the approval showed. */
async function approved(): Promise<{ id: string; code: string; expires_at: string }> {
  n += 1;
  const a = await addApplicant(w.deps(), w.operator, {
    slug: `new-pub-${String(n)}`,
    display_name: `New Pub ${String(n)}`,
    country: 'GB',
    reason: 'Met at the fair',
  });
  if (!a.ok) throw new Error(a.error.code);
  const d = await decideApplicant(w.deps(), w.operator, {
    publisher_id: a.value.publisher_id,
    decision: 'approve',
    reason: 'Checked in person',
  });
  if (!d.ok || d.value.invite === undefined) throw new Error('no invite on approval');
  return { id: a.value.publisher_id, ...d.value.invite };
}
const addAccount = (publisher_id: string, username: string) =>
  w.db.query(
    `INSERT INTO publisher_accounts
       (publisher_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 0, NULL, $4, $4, $4)`,
    [publisher_id, username, HASH, w.clock.now().toISOString()],
  );
const invitesOf = (publisher_id: string) =>
  q<{ code_hash: string; used_at: unknown; voided_at: unknown; expires_at: unknown }>(
    'SELECT code_hash, used_at, voided_at, expires_at FROM publisher_invites WHERE publisher_id = $1 ORDER BY created_at, id',
    [publisher_id],
  );
const live = async (publisher_id: string): Promise<number> =>
  (await invitesOf(publisher_id)).filter((i) => i.used_at === null && i.voided_at === null).length;

describe('the code', () => {
  it('has 12 characters from a 32 symbol alphabet and comes from the nonce', () => {
    expect(INVITE_CODE_LENGTH).toBe(12);
    expect(INVITE_ALPHABET).toHaveLength(32);
    expect(new Set(INVITE_ALPHABET).size).toBe(32);
    expect(INVITE_ALPHABET).toMatch(/^[0-9A-Z]+$/);
    const a = inviteCodeFromNonce('00112233445566778899aabbccddeeff');
    expect(a).toMatch(new RegExp(`^[${INVITE_ALPHABET}]{12}$`));
    expect(inviteCodeFromNonce('00112233445566778899aabbccddeeff')).toBe(a);
    expect(inviteCodeFromNonce('ffeeddccbbaa99887766554433221100')).not.toBe(a);
    expect(inviteCodeFromNonce('0'.repeat(32))).toBe(INVITE_ALPHABET[0]!.repeat(12));
    expect(inviteCodeFromNonce('f'.repeat(32))).toBe(INVITE_ALPHABET[31]!.repeat(12));
  });

  it('is hashed with SHA-256 after case, spaces and hyphens are folded', () => {
    const vector = 'f798776cb4d1e5975b47ed94fcc91314bc8d5c6935ff56b33c03b08c52356818';
    expect(hashInviteCode('ABCDEFGHJKMN')).toBe(vector);
    expect(hashInviteCode('abcd-efgh-jkmn')).toBe(vector);
    expect(hashInviteCode(' ABCD EFGH JKMN ')).toBe(vector);
    expect(normalizeInviteCode('abcd-efgh jkmn')).toBe('ABCDEFGHJKMN');
  });
});

describe('approving an applicant', () => {
  it('shows the code once, stores only its hash, and writes the audit rows without the code', async () => {
    const a = await approved();
    expect(a.code).toMatch(new RegExp(`^[${INVITE_ALPHABET}]{12}$`));
    expect(Date.parse(a.expires_at) - w.clock.now().getTime()).toBe(7 * DAY);
    expect(INVITE_TTL_MS).toBe(7 * DAY);
    const rows = await invitesOf(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(hashInviteCode(a.code));
    expect(rows[0]!.used_at).toBeNull();
    const all = JSON.stringify(await q('SELECT * FROM audit_log'));
    expect(all).not.toContain(a.code);
    const actions = (
      await q<{ action: string; actor_id: string; reason: string | null }>(
        'SELECT action, actor_id, reason FROM audit_log WHERE target = $1 ORDER BY created_at, id',
        [a.id],
      )
    ).map((r) => r.action);
    expect(actions).toEqual([
      'publisher.applicant_added',
      'publisher.applicant_approved',
      'publisher.invite_issued',
    ]);
    // the table holds no clear copy either
    expect(JSON.stringify(await q('SELECT * FROM publisher_invites'))).not.toContain(a.code);
  });

  it('a rejection issues no invite', async () => {
    n += 1;
    const a = await addApplicant(w.deps(), w.operator, {
      slug: `rej-pub-${String(n)}`,
      display_name: 'Rejected Pub',
      country: 'GB',
      reason: 'Met at the fair',
    });
    if (!a.ok) throw new Error(a.error.code);
    const d = await decideApplicant(w.deps(), w.operator, {
      publisher_id: a.value.publisher_id,
      decision: 'reject',
      reason: 'Not a fit now',
    });
    expect(d).toEqual({ ok: true, value: { state: 'rejected' } });
    expect(await invitesOf(a.value.publisher_id)).toEqual([]);
  });
});

describe('issueInvite', () => {
  it('replaces the live invite: the old one is voided, one stays live, the audit says issued', async () => {
    const a = await approved();
    w.clock.advance(1000);
    const r = await issueInvite(deps(), w.operator, {
      publisher_id: a.id,
      reason: 'Lost the code',
    });
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.code).not.toBe(a.code);
    expect(r.value.code).toMatch(new RegExp(`^[${INVITE_ALPHABET}]{12}$`));
    const rows = await invitesOf(a.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.voided_at).not.toBeNull();
    expect(rows[1]!.voided_at).toBeNull();
    expect(rows[1]!.code_hash).toBe(hashInviteCode(r.value.code));
    expect(await live(a.id)).toBe(1);
    const audits = await q<{ detail: Record<string, unknown>; reason: string }>(
      `SELECT detail, reason FROM audit_log WHERE target = $1 AND action = 'publisher.invite_issued' ORDER BY created_at, id`,
      [a.id],
    );
    expect(audits).toHaveLength(2);
    expect(audits[1]!.reason).toBe('Lost the code');
    expect(audits[1]!.detail).toMatchObject({ replaced: true });
    expect(JSON.stringify(await q('SELECT * FROM audit_log'))).not.toContain(r.value.code);
  });

  it('works after the old invite expired', async () => {
    const a = await approved();
    w.clock.advance(8 * DAY);
    const r = await issueInvite(deps(), w.operator, { publisher_id: a.id, reason: 'Expired' });
    expect(r.ok).toBe(true);
    expect(await live(a.id)).toBe(1);
  });

  it('refuses a publisher that already has an account', async () => {
    const a = await approved();
    await addAccount(a.id, `owner.${String(n)}`);
    expect(await issueInvite(deps(), w.operator, { publisher_id: a.id, reason: 'Again' })).toEqual({
      ok: false,
      error: { code: 'has_account' },
    });
  });

  it('refuses a demo publisher even when it has an account row, and an applicant, and a suspended one', async () => {
    await addAccount(w.pubId['harbour-ledger'], 'demo.harbour');
    for (const id of Object.values(w.pubId))
      expect(await issueInvite(deps(), w.operator, { publisher_id: id, reason: 'Try' })).toEqual({
        ok: false,
        error: { code: 'not_allowed' },
      });
    expect(
      (
        await q('SELECT 1 FROM publisher_invites WHERE publisher_id = ANY ($1::text[])', [
          Object.values(w.pubId),
        ])
      ).length,
    ).toBe(0);
    n += 1;
    const ap = await addApplicant(w.deps(), w.operator, {
      slug: `app-${String(n)}`,
      display_name: 'Still Applied',
      country: 'GB',
      reason: 'Met at the fair',
    });
    if (!ap.ok) throw new Error(ap.error.code);
    expect(
      await issueInvite(deps(), w.operator, {
        publisher_id: ap.value.publisher_id,
        reason: 'Early',
      }),
    ).toEqual({ ok: false, error: { code: 'not_allowed' } });
    const s = await approved();
    await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: s.id,
      status: 'suspended',
      reason: 'Under review',
    });
    expect(await issueInvite(deps(), w.operator, { publisher_id: s.id, reason: 'Try' })).toEqual({
      ok: false,
      error: { code: 'not_allowed' },
    });
  });

  it('refuses a bad actor, a missing second factor, a bad reason and an unknown id, and changes nothing', async () => {
    const a = await approved();
    const before = await invitesOf(a.id);
    const ok = { publisher_id: a.id, reason: 'Fine reason' };
    expect(await issueInvite(deps(), w.buyer, ok)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await issueInvite(deps(), w.harbour, ok)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(
      await issueInvite(deps(), { kind: 'operator', operator_id: 'opr_x', mfa: false }, ok),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    for (const reason of ['no', '  ', 'r'.repeat(201)])
      expect(await issueInvite(deps(), w.operator, { publisher_id: a.id, reason })).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    expect(
      await issueInvite(deps(), w.operator, { publisher_id: 'pub_guessed', reason: 'Fine reason' }),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await invitesOf(a.id)).toEqual(before);
  });
});

describe('resetPublisherSignIn', () => {
  it('removes the account, ends its sessions, voids the live invite and issues a new one', async () => {
    const a = await approved();
    await addAccount(a.id, `reset.${String(n)}`);
    await w.db.query(
      `INSERT INTO sessions (id, actor_kind, actor_id, csrf_token_hash, last_seen_at, expires_at, revoked_at, created_at, updated_at)
       VALUES ($1, 'publisher', $2, $3, $4, $5, NULL, $4, $4)`,
      [
        `ses_reset${String(n)}`,
        a.id,
        'b'.repeat(64),
        w.clock.now().toISOString(),
        '2099-01-01T00:00:00Z',
      ],
    );
    const r = await resetPublisherSignIn(deps(), w.operator, {
      publisher_id: a.id,
      reason: 'Lost it',
    });
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.code).toMatch(new RegExp(`^[${INVITE_ALPHABET}]{12}$`));
    expect(await q('SELECT 1 FROM publisher_accounts WHERE publisher_id = $1', [a.id])).toEqual([]);
    expect(
      (
        await q<{ revoked_at: unknown }>('SELECT revoked_at FROM sessions WHERE actor_id = $1', [
          a.id,
        ])
      )[0]!.revoked_at,
    ).not.toBeNull();
    expect(await live(a.id)).toBe(1);
    const actions = (
      await q<{ action: string }>('SELECT action FROM audit_log WHERE target = $1', [a.id])
    ).map((x) => x.action);
    expect(actions).toContain('publisher.sign_in_reset');
    expect(JSON.stringify(await q('SELECT * FROM audit_log'))).not.toContain(r.value.code);
  });

  it('works for a suspended publisher, refuses a demo slug and a publisher with no account', async () => {
    const a = await approved();
    await addAccount(a.id, `susp.${String(n)}`);
    await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: a.id,
      status: 'suspended',
      reason: 'Under review',
    });
    expect(
      (await resetPublisherSignIn(deps(), w.operator, { publisher_id: a.id, reason: 'Reset it' }))
        .ok,
    ).toBe(true);
    const none = await approved();
    expect(
      await resetPublisherSignIn(deps(), w.operator, { publisher_id: none.id, reason: 'Reset it' }),
    ).toEqual({ ok: false, error: { code: 'no_account' } });
    expect(
      await resetPublisherSignIn(deps(), w.operator, {
        publisher_id: w.pubId['harbour-ledger'],
        reason: 'Reset it',
      }),
    ).toEqual({ ok: false, error: { code: 'not_allowed' } });
    expect(
      await resetPublisherSignIn(deps(), w.buyer, { publisher_id: a.id, reason: 'Reset it' }),
    ).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(
      await resetPublisherSignIn(
        deps(),
        { kind: 'operator', operator_id: 'opr_x', mfa: false },
        { publisher_id: a.id, reason: 'Reset it' },
      ),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
  });
});

describe('listPublisherAccess', () => {
  it('omits the demo publishers and applicants, and shows account, invite and link state', async () => {
    const a = await approved();
    const claimed = await approved();
    await addAccount(claimed.id, `claimed.${String(n)}`);
    await w.db.query('UPDATE publisher_invites SET used_at = $2 WHERE publisher_id = $1', [
      claimed.id,
      w.clock.now().toISOString(),
    ]);
    const rows = await listPublisherAccess(deps(), w.operator);
    if (rows === null) throw new Error('null');
    const slugs = rows.map((r) => r.slug);
    for (const d of DEMO) expect(slugs).not.toContain(d);
    expect(rows.every((r) => r.status !== 'applied')).toBe(true);
    const mine = rows.find((r) => r.publisher_id === a.id)!;
    expect(mine).toMatchObject({ username: null, invite: 'live', link: null, terms: null });
    expect(Date.parse(mine.invite_expires_at!)).toBe(Date.parse(a.expires_at));
    const done = rows.find((r) => r.publisher_id === claimed.id)!;
    expect(done).toMatchObject({ invite: 'used', username: `claimed.${String(n)}` });
    // the code and its hash never leave the module
    expect(JSON.stringify(rows)).not.toContain(a.code);
    expect(JSON.stringify(rows)).not.toContain(hashInviteCode(a.code));
    w.clock.advance(9 * DAY);
    const later = await listPublisherAccess(deps(), w.operator);
    expect(later!.find((r) => r.publisher_id === a.id)!.invite).toBe('expired');
  });

  it('answers null to anything but an operator with the second factor', async () => {
    expect(await listPublisherAccess(deps(), w.buyer)).toBeNull();
    expect(await listPublisherAccess(deps(), w.harbour)).toBeNull();
    expect(
      await listPublisherAccess(deps(), { kind: 'operator', operator_id: 'opr_x', mfa: false }),
    ).toBeNull();
  });
});
