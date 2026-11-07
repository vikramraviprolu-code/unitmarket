// Invite codes for new publishers (POB-P1, decision D-089 items 1 and 6). After an operator approves an
// applicant, or issues a code for an active publisher with no account, the operator sees a one time code: 12
// characters from a 32 symbol alphabet. The code is returned once and never stored, logged or audited in clear:
// the table holds its SHA-256 and the audit row says issued, not the code. A code lives 7 days; a new invite voids
// the old one (one live invite per publisher). Reset sign in removes the account and its sessions and issues a
// new code. The three demo publishers sign in with their personas and are never issued a code: the caller passes
// their slugs in `demo_slugs`, because this domain cannot import the web app's persona list.
// The claim itself (scrypt, lockout) is in @umsbx/security; it hashes a code exactly as `hashInviteCode` does.
import { createHash } from 'node:crypto';
import { err, isSyntheticPayee, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Id, Result, SqlExecutor } from '@umsbx/contracts';
import { maskEmail } from './paypal-link';
import type { PaypalLinkState } from './paypal-link';

export type InviteDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'> & {
  /** Slugs of the demo publishers: never issued an invite, never listed. */
  demo_slugs: readonly string[];
};
export type InviteErrorCode =
  | 'not_operator'
  | 'mfa_required'
  | 'invalid_input'
  | 'not_found'
  | 'not_allowed'
  | 'has_account'
  | 'no_account';
export interface InviteError {
  code: InviteErrorCode;
}
export interface IssuedInvite {
  /** The clear code, 12 characters. Shown to the operator once; nothing keeps it. */
  code: string;
  expires_at: string;
}

/** Digits and capital letters without I, L, O and U: 32 symbols, 5 bits each. */
export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_CODE_LENGTH = 12;
export const INVITE_TTL_MS = 7 * 86_400_000;

/** 12 symbols from the first 60 bits of a 32 hex character nonce (Ids.nonce()). */
export function inviteCodeFromNonce(nonce: string): string {
  if (!/^[0-9a-f]{32}$/.test(nonce))
    throw new Error('inviteCodeFromNonce: not a 32 character nonce');
  const bits = BigInt(`0x${nonce.slice(0, 15)}`);
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++)
    code += INVITE_ALPHABET[Number((bits >> BigInt(5 * (INVITE_CODE_LENGTH - 1 - i))) & 31n)]!;
  return code;
}

/** Capital letters, no spaces, no hyphens: the form an operator reads out and a publisher types. */
export const normalizeInviteCode = (raw: string): string =>
  raw.replace(/[\s-]+/g, '').toUpperCase();

/** The stored form of a code. */
export const hashInviteCode = (code: string): string =>
  createHash('sha256').update(normalizeInviteCode(code), 'utf8').digest('hex');

const fail = (code: InviteErrorCode): Result<never, InviteError> => err({ code });
class Refused extends Error {
  // Declared field, not a parameter property: the offline scripts run this file in Node's strip-only mode.
  readonly code: InviteErrorCode;
  constructor(code: InviteErrorCode) {
    super(code);
    this.code = code;
  }
}
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const reasonOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  return r.length >= 3 && r.length <= 200 ? r : null;
};

function gate(operator: Actor): Result<never, InviteError> | null {
  if (operator.kind !== 'operator') return fail('not_operator');
  if (!operator.mfa) return fail('mfa_required');
  return null;
}

/**
 * Voids the publisher's live invite, if any, stores a new one and audits "issued" (never the code). The caller
 * has locked the publisher row and made every check. Used by approval, by issue and by reset.
 */
export async function issueInviteIn(
  tx: SqlExecutor,
  deps: Pick<CoreDeps, 'clock' | 'ids' | 'audit'>,
  operator: Actor,
  input: { publisher_id: Id; reason: string; via: 'approval' | 'issue' | 'reset' },
): Promise<IssuedInvite> {
  const now = deps.clock.now();
  const at = now.toISOString();
  const voided = await tx.query(
    `UPDATE publisher_invites SET voided_at = $2, updated_at = $2
      WHERE publisher_id = $1 AND used_at IS NULL AND voided_at IS NULL RETURNING id`,
    [input.publisher_id, at],
  );
  const code = inviteCodeFromNonce(deps.ids.nonce());
  const expires_at = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  await tx.query(
    `INSERT INTO publisher_invites (id, publisher_id, code_hash, expires_at, used_at, voided_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $6)`,
    [
      deps.ids.next('aud'),
      input.publisher_id,
      hashInviteCode(code),
      expires_at,
      operator.kind === 'operator' ? operator.operator_id : '',
      at,
    ],
  );
  await deps.audit.record(tx, {
    actor: operator,
    action: 'publisher.invite_issued',
    target: input.publisher_id,
    reason: input.reason,
    detail: { via: input.via, replaced: voided.rows.length > 0, expires_at },
  });
  return { code, expires_at };
}

interface PublisherLock {
  slug: string;
  status: string;
}
async function lockPublisher(tx: SqlExecutor, id: Id): Promise<PublisherLock> {
  const p = await tx.query<PublisherLock>(
    'SELECT slug, status FROM publishers WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = p.rows[0];
  if (row === undefined) throw new Refused('not_found');
  return row;
}

function checked(
  operator: Actor,
  input: { publisher_id: Id; reason: string },
): { reason: string } | Result<never, InviteError> {
  const g = gate(operator);
  if (g !== null) return g;
  const reason = reasonOf(input.reason);
  if (reason === null || typeof input.publisher_id !== 'string' || input.publisher_id.length === 0)
    return fail('invalid_input');
  return { reason };
}

/**
 * Issues (or replaces) the invite of an active publisher that has no account. A demo publisher, an applicant and
 * a suspended publisher are `not_allowed`; a publisher with an account is `has_account` (use reset instead).
 */
export async function issueInvite(
  deps: InviteDeps,
  operator: Actor,
  input: { publisher_id: Id; reason: string },
): Promise<Result<IssuedInvite, InviteError>> {
  const c = checked(operator, input);
  if (!('reason' in c)) return c;
  try {
    return await deps.db.transaction(async (tx) => {
      const p = await lockPublisher(tx, input.publisher_id);
      if (deps.demo_slugs.includes(p.slug) || p.status !== 'active')
        throw new Refused('not_allowed');
      const acct = await tx.query('SELECT 1 FROM publisher_accounts WHERE publisher_id = $1', [
        input.publisher_id,
      ]);
      if (acct.rows.length > 0) throw new Refused('has_account');
      return ok(
        await issueInviteIn(tx, deps, operator, {
          publisher_id: input.publisher_id,
          reason: c.reason,
          via: 'issue',
        }),
      );
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * Reset sign in: removes the account (so its password is void), ends every session of the publisher and issues
 * a new invite so the publisher can claim the account again. Works for any status. A demo publisher is
 * `not_allowed` even if it has an account row; a publisher with no account is `no_account`.
 */
export async function resetPublisherSignIn(
  deps: InviteDeps,
  operator: Actor,
  input: { publisher_id: Id; reason: string },
): Promise<Result<IssuedInvite, InviteError>> {
  const c = checked(operator, input);
  if (!('reason' in c)) return c;
  try {
    return await deps.db.transaction(async (tx) => {
      const p = await lockPublisher(tx, input.publisher_id);
      if (deps.demo_slugs.includes(p.slug)) throw new Refused('not_allowed');
      const gone = await tx.query(
        'DELETE FROM publisher_accounts WHERE publisher_id = $1 RETURNING publisher_id',
        [input.publisher_id],
      );
      if (gone.rows.length === 0) throw new Refused('no_account');
      const at = deps.clock.now().toISOString();
      const ended = await tx.query(
        `UPDATE sessions SET revoked_at = $2, updated_at = $2
          WHERE actor_kind = 'publisher' AND actor_id = $1 AND revoked_at IS NULL RETURNING id`,
        [input.publisher_id, at],
      );
      const invite = await issueInviteIn(tx, deps, operator, {
        publisher_id: input.publisher_id,
        reason: c.reason,
        via: 'reset',
      });
      await deps.audit.record(tx, {
        actor: operator,
        action: 'publisher.sign_in_reset',
        target: input.publisher_id,
        reason: c.reason,
        detail: { sessions_revoked: ended.rows.length },
      });
      return ok(invite);
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

export type InviteState = 'none' | 'live' | 'expired' | 'used';
export interface PublisherAccessRow {
  publisher_id: Id;
  slug: string;
  display_name: string;
  status: string;
  username: string | null;
  account_locked: boolean;
  invite: InviteState;
  invite_expires_at: string | null;
  terms: { version: string; method: string } | null;
  link: { state: PaypalLinkState; masked_email: string; synthetic?: true } | null;
}

/**
 * The operator's access list: every publisher that is not an applicant and not a demo publisher, with its
 * account, invite, terms and PayPal link state. The code and its hash never leave this module; the link email is
 * masked. Null for any actor that is not an operator with the second factor.
 */
export async function listPublisherAccess(
  deps: Pick<InviteDeps, 'db' | 'clock' | 'demo_slugs'>,
  operator: Actor,
): Promise<PublisherAccessRow[] | null> {
  if (operator.kind !== 'operator' || !operator.mfa) return null;
  const now = deps.clock.now().getTime();
  const pubs = await deps.db.query<{
    id: string;
    slug: string;
    display_name: string;
    status: string;
  }>(
    `SELECT id, slug, display_name, status FROM publishers
      WHERE status <> 'applied' AND NOT (slug = ANY ($1::text[])) ORDER BY created_at, id`,
    [[...deps.demo_slugs]],
  );
  const accounts = await deps.db.query<{
    publisher_id: string;
    username: string;
    locked_until: unknown;
  }>('SELECT publisher_id, username, locked_until FROM publisher_accounts');
  const invites = await deps.db.query<{
    publisher_id: string;
    expires_at: unknown;
    used_at: unknown;
  }>(
    `SELECT DISTINCT ON (publisher_id) publisher_id, expires_at, used_at FROM publisher_invites
      WHERE voided_at IS NULL ORDER BY publisher_id, created_at DESC, id DESC`,
  );
  const terms = await deps.db.query<{
    publisher_id: string;
    terms_version: string;
    method: string;
  }>(
    `SELECT DISTINCT ON (publisher_id) publisher_id, terms_version, method FROM publisher_agreements
      ORDER BY publisher_id, accepted_at DESC, id DESC`,
  );
  const links = await deps.db.query<{
    publisher_id: string;
    paypal_email: string;
    state: PaypalLinkState;
    verified_by: string | null;
  }>('SELECT publisher_id, paypal_email, state, verified_by FROM publisher_paypal_links');
  const by = <T extends { publisher_id: string }>(rows: T[]): Map<string, T> =>
    new Map(rows.map((r) => [r.publisher_id, r]));
  const A = by(accounts.rows);
  const I = by(invites.rows);
  const T = by(terms.rows);
  const L = by(links.rows);
  return pubs.rows.map((p) => {
    const a = A.get(p.id);
    const i = I.get(p.id);
    const t = T.get(p.id);
    const l = L.get(p.id);
    let invite: InviteState = 'none';
    if (i !== undefined)
      invite =
        i.used_at != null ? 'used' : Date.parse(iso(i.expires_at)) > now ? 'live' : 'expired';
    return {
      publisher_id: p.id,
      slug: p.slug,
      display_name: p.display_name,
      status: p.status,
      username: a?.username ?? null,
      account_locked: a?.locked_until != null && Date.parse(iso(a.locked_until)) > now,
      invite,
      invite_expires_at: i === undefined ? null : iso(i.expires_at),
      terms: t === undefined ? null : { version: t.terms_version, method: t.method },
      link:
        l === undefined
          ? null
          : {
              state: l.state,
              masked_email: maskEmail(l.paypal_email),
              // POB-DEMOLINK: the dry run seed's demo address is not an operator check
              ...(l.state === 'verified' && isSyntheticPayee(l.paypal_email, l.verified_by)
                ? { synthetic: true as const }
                : {}),
            },
    };
  });
}
