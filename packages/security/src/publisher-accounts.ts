// Publisher accounts (POB-P1, decision D-089): a new publisher claims an account with the one time invite code an
// operator gave them, then signs in with a username and a password. This is the buyer scheme of accounts.ts
// (scrypt hash with a salt from deps.ids, the buyer password policy, the same lock) on the publisher_accounts table.
// A wrong, expired, used or voided code all answer `invalid_code`, and every path that reaches the code lookup has
// already done exactly one scrypt hash, so a wrong code costs the same as a right one. Ten tries per address in 15
// minutes (PUBLISHER_CLAIM_RATE) are the brute force limit; the code has 60 bits. A username is told to be taken only
// to someone holding a valid code. Sign in needs an active publisher; the check comes after the one scrypt
// verification and fails like a wrong password without counting as one. Nothing here logs or audits a password or a
// code: the invite is looked up by its SHA-256, and a failed sign in is audited by a keyed hash of the name only.
import { createHash, createHmac } from 'node:crypto';
import type { Id } from '@umsbx/contracts';
import { ACCOUNT_DUMMY_HASH, USERNAME_PATTERN, checkPasswordPolicy, lockFor } from './accounts';
import type { PasswordRefusal } from './accounts';
import { hashPasscode, verifyPasscode } from './passcode';
import { takeToken } from './rate';
import type { RateRule } from './rate';
import type { SecurityDeps } from './route';

/** Digits and capital letters without I, L, O and U: the same 32 symbols the catalogue domain issues. */
export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
/** Claim tries per address: every well formed try spends one, a right one included. */
export const PUBLISHER_CLAIM_RATE = {
  name: 'publisher-claim',
  per: 'ip',
  limit: 10,
  window_ms: 15 * 60_000,
} as const satisfies RateRule;

/** Capital letters, no spaces and no hyphens (what the operator reads out may be grouped). */
export const normalizeInviteCode = (raw: string): string =>
  raw.replace(/[\s-]+/g, '').toUpperCase();
/** The stored form of a code; the catalogue domain hashes it the same way (the vector is pinned in both tests). */
export const hashInviteCode = (code: string): string =>
  createHash('sha256').update(normalizeInviteCode(code), 'utf8').digest('hex');

export type ClaimCheck =
  | { ok: true; code: string }
  | { ok: false; code: 'invalid_input' }
  | { ok: false; code: 'weak_password'; reason: PasswordRefusal };

/** The shape of a claim and the password policy, with no database. A refusal here spends nothing. */
export function checkClaim(i: { code: string; username: string; password: string }): ClaimCheck {
  const code = normalizeInviteCode(i.code);
  if (!CODE_SHAPE.test(code) || !USERNAME_PATTERN.test(i.username))
    return { ok: false, code: 'invalid_input' };
  const verdict = checkPasswordPolicy(i.password, { username: i.username });
  if (!verdict.ok) return { ok: false, code: 'weak_password', reason: verdict.reason };
  return { ok: true, code };
}

export type ClaimResult =
  | { ok: true; publisher_id: Id }
  | { ok: false; code: 'invalid_input' | 'invalid_code' | 'taken' | 'rate_limited' }
  | { ok: false; code: 'weak_password'; reason: PasswordRefusal };

class Taken extends Error {}
class BadCode extends Error {}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

/**
 * Makes the account for the publisher the invite names, marks the invite used and writes one audit row, in one
 * transaction. The caller makes the session. The invite must be unused, unvoided, unexpired, and the publisher
 * active with no account; anything else is `invalid_code`.
 */
export async function claimPublisherAccount(
  deps: SecurityDeps,
  i: { code: string; username: string; password: string; ip_hash: string },
): Promise<ClaimResult> {
  const checked = checkClaim(i);
  if (!checked.ok) return checked;
  const v = await takeToken(deps, PUBLISHER_CLAIM_RATE, i.ip_hash);
  if (!v.allowed) return { ok: false, code: 'rate_limited' };
  // One scrypt hash on every path from here, so a wrong code costs what a right one does.
  const hash = await hashPasscode(i.password, deps.ids.nonce());
  const code_hash = hashInviteCode(checked.code);
  try {
    return await deps.db.transaction(async (tx): Promise<ClaimResult> => {
      const now = deps.clock.now().getTime();
      const at = new Date(now).toISOString();
      const inv = await tx.query<{ id: string; publisher_id: string; expires_at: unknown }>(
        `SELECT id, publisher_id, expires_at FROM publisher_invites
          WHERE code_hash = $1 AND used_at IS NULL AND voided_at IS NULL FOR UPDATE`,
        [code_hash],
      );
      const invite = inv.rows[0];
      if (invite === undefined || ms(invite.expires_at) <= now) throw new BadCode();
      const p = await tx.query<{ status: string }>(
        'SELECT status FROM publishers WHERE id = $1 FOR UPDATE',
        [invite.publisher_id],
      );
      if (p.rows[0]?.status !== 'active') throw new BadCode();
      const had = await tx.query('SELECT 1 FROM publisher_accounts WHERE publisher_id = $1', [
        invite.publisher_id,
      ]);
      if (had.rows.length > 0) throw new BadCode();
      const made = await tx.query(
        `INSERT INTO publisher_accounts
           (publisher_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 0, NULL, $4, $4, $4) ON CONFLICT (username) DO NOTHING RETURNING publisher_id`,
        [invite.publisher_id, i.username, hash, at],
      );
      if (made.rows.length === 0) throw new Taken();
      await tx.query('UPDATE publisher_invites SET used_at = $2, updated_at = $2 WHERE id = $1', [
        invite.id,
        at,
      ]);
      await deps.audit.record(tx, {
        actor: { kind: 'publisher', publisher_id: invite.publisher_id },
        action: 'publisher_account.claimed',
        target: invite.publisher_id,
        reason: null,
        detail: {},
      });
      return { ok: true, publisher_id: invite.publisher_id };
    });
  } catch (e) {
    if (e instanceof BadCode) return { ok: false, code: 'invalid_code' };
    if (e instanceof Taken) return { ok: false, code: 'taken' };
    throw e;
  }
}

// ---- sign in ---------------------------------------------------------------------------------------------

interface AccountRow {
  publisher_id: string;
  username: string;
  password_hash: string;
  failed_attempts: number | string;
  locked_until: unknown;
  updated_at: unknown;
  status: string;
}
type Tx = Parameters<Parameters<SecurityDeps['db']['transaction']>[0]>[0];

const isLocked = (row: AccountRow, now: number): boolean =>
  row.locked_until !== null && row.locked_until !== undefined && ms(row.locked_until) > now;

/** A keyed hash of a username, for the audit log: the name itself is never written for a failed sign in. */
function usernameHash(deps: SecurityDeps, username: string): string {
  return createHmac('sha256', deps.session_secret.reveal())
    .update(`publisher-account-user:${username}`)
    .digest('hex')
    .slice(0, 32);
}

export type PublisherLoginResult = { ok: true; publisher_id: Id } | { ok: false };

/**
 * Checks a username and a password. Every path runs exactly one scrypt verification before it touches the row, so
 * an unknown name, a wrong password, a locked account and an inactive publisher cost the same and answer the same.
 * Twenty wrong passwords in a row lock the account (the buyer lock). A right password for a publisher that is not
 * active fails without counting.
 */
export async function verifyPublisherLogin(
  deps: SecurityDeps,
  i: { username: string; password: string },
): Promise<PublisherLoginResult> {
  const shaped = USERNAME_PATTERN.test(i.username);
  const peek = shaped
    ? await deps.db.query<{ password_hash: string }>(
        'SELECT password_hash FROM publisher_accounts WHERE username = $1',
        [i.username],
      )
    : { rows: [] as { password_hash: string }[] };
  const good = await verifyPasscode(peek.rows[0]?.password_hash ?? ACCOUNT_DUMMY_HASH, i.password);
  const failed = (tx: Tx, held: boolean, row: AccountRow | undefined): Promise<void> =>
    deps.audit.record(tx, {
      actor: { kind: 'system' },
      action: 'publisher_account.login_failed',
      target: null,
      reason: null,
      detail: {
        username_hash: usernameHash(deps, row?.username ?? i.username),
        ...(held ? { held: true } : {}),
      },
    });
  return deps.db.transaction(async (tx): Promise<PublisherLoginResult> => {
    const res = shaped
      ? await tx.query<AccountRow>(
          `SELECT a.publisher_id, a.username, a.password_hash, a.failed_attempts, a.locked_until, a.updated_at, p.status
             FROM publisher_accounts a JOIN publishers p ON p.id = a.publisher_id
            WHERE a.username = $1 FOR UPDATE OF a`,
          [i.username],
        )
      : { rows: [] as AccountRow[] };
    const row = res.rows[0];
    const now = deps.clock.now().getTime();
    if (row === undefined) {
      await failed(tx, false, undefined);
      return { ok: false };
    }
    const locked = isLocked(row, now);
    if (locked || !good || row.password_hash !== peek.rows[0]?.password_hash) {
      // A lock never changes by being tried; a wrong password counts.
      if (locked) {
        await failed(tx, true, row);
        return { ok: false };
      }
      const stale = now - ms(row.updated_at) > 24 * 60 * 60_000;
      const count = (stale ? 0 : Number(row.failed_attempts)) + 1;
      const lock = lockFor(count);
      await tx.query(
        'UPDATE publisher_accounts SET failed_attempts = $2, locked_until = $3, updated_at = $4 WHERE publisher_id = $1',
        [
          row.publisher_id,
          count,
          lock > 0 ? new Date(now + lock).toISOString() : null,
          new Date(now).toISOString(),
        ],
      );
      await failed(tx, false, row);
      if (lock > 0)
        await deps.audit.record(tx, {
          actor: { kind: 'system' },
          action: 'publisher_account.locked',
          target: row.publisher_id,
          reason: null,
          detail: { failed_attempts: count, lock_ms: lock },
        });
      return { ok: false };
    }
    if (row.status !== 'active') {
      await failed(tx, true, row);
      return { ok: false };
    }
    await tx.query(
      'UPDATE publisher_accounts SET failed_attempts = 0, locked_until = NULL, updated_at = $2 WHERE publisher_id = $1',
      [row.publisher_id, new Date(now).toISOString()],
    );
    await deps.audit.record(tx, {
      actor: { kind: 'publisher', publisher_id: row.publisher_id },
      action: 'publisher_account.login',
      target: row.publisher_id,
      reason: null,
      detail: {},
    });
    return { ok: true, publisher_id: row.publisher_id };
  });
}
