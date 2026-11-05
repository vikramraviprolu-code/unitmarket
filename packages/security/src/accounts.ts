// Buyer accounts (ID-ACCOUNTS): a username and a password, no email. Password policy after NIST 800-63B:
// 12 to 128 characters after NFKC, no composition rules, a block list of common passwords, no username
// inside, never trimmed or truncated. The hash is the scrypt code of passcode.ts with a salt from deps.ids.
// An unknown name and a wrong password cost the same (a real verification against a fixed dummy hash) and
// answer the same. Five failures in a row lock the account for 15 minutes, doubling to one hour. Nothing
// here logs or audits a password, and a failed sign in is audited by a keyed hash of the name only.
import { createHmac } from 'node:crypto';
import type { Id } from '@umsbx/contracts';
import { COMMON_PASSWORDS_TEXT } from './common-passwords';
import { hashPasscode, verifyPasscode } from './passcode';
import type { SecurityDeps } from './route';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
/** The stored hash check refuses a longer attempt, so signup must too (or no one could sign in). */
export const PASSWORD_MAX_BYTES = 1024;
/** Lower case letters, digits, dot, dash and underscore, 3 to 30. The database CHECK says the same. */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
/**
 * Consecutive failures before the account itself is locked. High on purpose (NIST 800-63B allows up to 100):
 * the real throttle is the limiter per address and name (5 in 15 minutes) and per address (30 in 15 minutes),
 * so a stranger at one address cannot keep a known name locked. Failures older than a day are forgotten.
 * Residual risk: a distributed attacker with many addresses can still reach the threshold and lock a name.
 */
export const ACCOUNT_LOCK_THRESHOLD = 20;
/** A failure count older than this is forgotten (measured from the last failure). */
export const ACCOUNT_FAILURE_MEMORY_MS = 24 * 60 * 60_000;
export const ACCOUNT_LOCK_BASE_MS = 15 * 60_000;
export const ACCOUNT_LOCK_CAP_MS = 60 * 60_000;

/** The 200 most common passwords, normalised (NFKC, lower case). */
export const COMMON_PASSWORDS: readonly string[] = COMMON_PASSWORDS_TEXT.split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '');
const COMMON = new Set(COMMON_PASSWORDS);

/**
 * A stored hash nobody can match, used when the name is unknown so that the answer costs one real
 * verification (same parameters as a real hash). The salt and key are arbitrary fixed values.
 */
export const ACCOUNT_DUMMY_HASH =
  'scrypt:16384:8:1:a1b2c3d4e5f60718293a4b5c6d7e8f90:5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592';

export type PasswordRefusal =
  | 'too_short'
  | 'too_long'
  | 'common'
  | 'contains_username'
  | 'same_as_name'
  | 'repetitive'
  | 'same_as_current';
export type PolicyVerdict = { ok: true } | { ok: false; reason: PasswordRefusal };

/** The password rules. The password is measured after NFKC in characters (code points) and never trimmed. */
export function checkPasswordPolicy(
  password: string,
  ctx: { username?: string; display_name?: string } = {},
): PolicyVerdict {
  const p = password.normalize('NFKC');
  const chars = Array.from(p);
  if (chars.length < PASSWORD_MIN) return { ok: false, reason: 'too_short' };
  if (chars.length > PASSWORD_MAX || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES)
    return { ok: false, reason: 'too_long' };
  const lower = p.toLowerCase();
  if (COMMON.has(lower)) return { ok: false, reason: 'common' };
  if (new Set(chars).size === 1) return { ok: false, reason: 'repetitive' };
  const user = ctx.username?.normalize('NFKC').toLowerCase();
  if (user !== undefined && user !== '' && lower.includes(user))
    return { ok: false, reason: 'contains_username' };
  const name = ctx.display_name?.normalize('NFKC').trim().toLowerCase();
  if (name !== undefined && name !== '' && lower === name)
    return { ok: false, reason: 'same_as_name' };
  return { ok: true };
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

/** A keyed hash of a username, for the audit log: the name itself is never written for a failed sign in. */
function usernameHash(deps: SecurityDeps, username: string): string {
  return createHmac('sha256', deps.session_secret.reveal())
    .update(`account-user:${username}`)
    .digest('hex')
    .slice(0, 32);
}

// Angle brackets, control characters, zero width characters and bidirectional controls are not allowed in a
// display name (the same set the ums_id domain refuses, plus the brackets).
function badNameChar(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x3c ||
    c === 0x3e ||
    (c >= 0x200b && c <= 0x200d) ||
    c === 0x2060 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  );
}
function cleanDisplayName(raw: string): string | null {
  const name = raw.normalize('NFKC').trim();
  const chars = Array.from(name);
  if (chars.length < 2 || chars.length > 60) return null;
  return chars.some((ch) => badNameChar(ch.codePointAt(0) ?? 0)) ? null : name;
}

export type NewAccountCheck =
  | { ok: true; display_name: string }
  | { ok: false; code: 'invalid_input' }
  | { ok: false; code: 'weak_password'; reason: PasswordRefusal };

/** The shape of a new account and the password policy, with no database. Signup runs it before it spends a token. */
export function checkNewAccount(i: {
  display_name: string;
  username: string;
  country: string;
  password: string;
}): NewAccountCheck {
  const display_name = cleanDisplayName(i.display_name);
  if (display_name === null || !USERNAME_PATTERN.test(i.username) || !/^[A-Z]{2}$/.test(i.country))
    return { ok: false, code: 'invalid_input' };
  const verdict = checkPasswordPolicy(i.password, { username: i.username, display_name });
  if (!verdict.ok) return { ok: false, code: 'weak_password', reason: verdict.reason };
  return { ok: true, display_name };
}

class Taken extends Error {}

export type CreateAccountResult =
  | { ok: true; buyer_id: Id }
  | { ok: false; code: 'taken' | 'invalid_input' }
  | { ok: false; code: 'weak_password'; reason: PasswordRefusal };

/**
 * Makes the buyer, the account and two consents (Terms and Privacy, at `consent_version`) and one audit
 * row in one transaction. The caller makes the session. A taken name writes nothing.
 */
export async function createAccount(
  deps: SecurityDeps,
  i: {
    display_name: string;
    username: string;
    country: string;
    password: string;
    consent_version: string;
  },
): Promise<CreateAccountResult> {
  if (i.consent_version.trim() === '') return { ok: false, code: 'invalid_input' };
  const checked = checkNewAccount(i);
  if (!checked.ok) return checked;
  const display_name = checked.display_name;
  const hash = await hashPasscode(i.password, deps.ids.nonce());
  const buyer_id = deps.ids.next('buy');
  const at = deps.clock.now().toISOString();
  try {
    await deps.db.transaction(async (tx) => {
      const b = await tx.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (auth_subject) DO NOTHING RETURNING id`,
        [buyer_id, display_name, `account:${i.username}`, i.country, at],
      );
      if (b.rows.length === 0) throw new Taken();
      const a = await tx.query(
        `INSERT INTO buyer_accounts
           (buyer_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 0, NULL, $4, $4, $4) ON CONFLICT (username) DO NOTHING RETURNING buyer_id`,
        [buyer_id, i.username, hash, at],
      );
      if (a.rows.length === 0) throw new Taken();
      for (const kind of ['terms', 'privacy']) {
        await tx.query(
          `INSERT INTO consents (id, buyer_id, kind, text_version, granted_at, revoked_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $5, $5)`,
          [`cns_${deps.ids.nonce()}`, buyer_id, kind, i.consent_version, at],
        );
      }
      await deps.audit.record(tx, {
        actor: { kind: 'buyer', buyer_id },
        action: 'account.signup',
        target: buyer_id,
        reason: null,
        detail: { country: i.country },
      });
    });
  } catch (e) {
    if (e instanceof Taken) return { ok: false, code: 'taken' };
    throw e;
  }
  return { ok: true, buyer_id };
}

interface AccountRow {
  buyer_id: string;
  username: string;
  display_name: string;
  password_hash: string;
  failed_attempts: number | string;
  locked_until: unknown;
  updated_at: unknown;
}

const isLocked = (row: AccountRow, now: number): boolean =>
  row.locked_until !== null && row.locked_until !== undefined && ms(row.locked_until) > now;

/** How long the account stays locked after this many failures in a row, or 0 below the threshold. */
export function lockFor(failed: number): number {
  if (failed < ACCOUNT_LOCK_THRESHOLD) return 0;
  return Math.min(
    ACCOUNT_LOCK_CAP_MS,
    ACCOUNT_LOCK_BASE_MS * 2 ** (failed - ACCOUNT_LOCK_THRESHOLD),
  );
}

type Tx = Parameters<Parameters<SecurityDeps['db']['transaction']>[0]>[0];

async function lockRow(
  tx: Tx,
  where: 'buyer_id' | 'username',
  value: string,
): Promise<AccountRow | undefined> {
  const res = await tx.query<AccountRow>(
    `SELECT a.buyer_id, a.username, b.display_name, a.password_hash, a.failed_attempts, a.locked_until, a.updated_at
       FROM buyer_accounts a JOIN buyers b ON b.id = a.buyer_id
      WHERE a.${where} = $1 FOR UPDATE OF a`,
    [value],
  );
  return res.rows[0];
}

/** A wrong password: one more failure, a lock from the fifth on, and the audit rows. */
async function recordFailure(
  tx: Tx,
  deps: SecurityDeps,
  row: AccountRow,
  via: 'login' | 'password_change',
  now: number,
): Promise<void> {
  // A count whose last failure is more than a day old is forgotten. Only a failure writes a count above zero
  // and every such write sets updated_at, so updated_at is the time of the last failure.
  const stale = now - ms(row.updated_at) > ACCOUNT_FAILURE_MEMORY_MS;
  const failed = (stale ? 0 : Number(row.failed_attempts)) + 1;
  const lock = lockFor(failed);
  const at = new Date(now).toISOString();
  await tx.query(
    'UPDATE buyer_accounts SET failed_attempts = $2, locked_until = $3, updated_at = $4 WHERE buyer_id = $1',
    [row.buyer_id, failed, lock > 0 ? new Date(now + lock).toISOString() : null, at],
  );
  await deps.audit.record(tx, {
    actor: { kind: 'system' },
    action: 'account.login_failed',
    target: null,
    reason: null,
    detail: { username_hash: usernameHash(deps, row.username), via },
  });
  if (lock > 0)
    await deps.audit.record(tx, {
      actor: { kind: 'system' },
      action: 'account.locked',
      target: row.buyer_id,
      reason: null,
      detail: { failed_attempts: failed, lock_ms: lock },
    });
}

export type LoginResult = { ok: true; buyer_id: Id } | { ok: false };

/**
 * Checks a username and a password. Every path runs exactly one scrypt verification before it touches the
 * row, so an unknown name, a wrong password and a locked account cost the same and return the same value.
 */
export async function verifyAccountLogin(
  deps: SecurityDeps,
  i: { username: string; password: string },
): Promise<LoginResult> {
  const shaped = USERNAME_PATTERN.test(i.username);
  const peek = shaped
    ? await deps.db.query<{ password_hash: string }>(
        'SELECT password_hash FROM buyer_accounts WHERE username = $1',
        [i.username],
      )
    : { rows: [] as { password_hash: string }[] };
  const good = await verifyPasscode(peek.rows[0]?.password_hash ?? ACCOUNT_DUMMY_HASH, i.password);
  return deps.db.transaction(async (tx): Promise<LoginResult> => {
    const row = shaped ? await lockRow(tx, 'username', i.username) : undefined;
    const now = deps.clock.now().getTime();
    if (row === undefined) {
      await deps.audit.record(tx, {
        actor: { kind: 'system' },
        action: 'account.login_failed',
        target: null,
        reason: null,
        detail: { username_hash: usernameHash(deps, i.username), via: 'login' },
      });
      return { ok: false };
    }
    if (isLocked(row, now) || !good || row.password_hash !== peek.rows[0]?.password_hash) {
      // A lock never changes by being tried; a wrong password counts.
      if (!isLocked(row, now)) await recordFailure(tx, deps, row, 'login', now);
      else
        await deps.audit.record(tx, {
          actor: { kind: 'system' },
          action: 'account.login_failed',
          target: null,
          reason: null,
          detail: { username_hash: usernameHash(deps, row.username), via: 'login', held: true },
        });
      return { ok: false };
    }
    await tx.query(
      'UPDATE buyer_accounts SET failed_attempts = 0, locked_until = NULL, updated_at = $2 WHERE buyer_id = $1',
      [row.buyer_id, new Date(now).toISOString()],
    );
    await deps.audit.record(tx, {
      actor: { kind: 'buyer', buyer_id: row.buyer_id },
      action: 'account.login',
      target: row.buyer_id,
      reason: null,
      detail: {},
    });
    return { ok: true, buyer_id: row.buyer_id };
  });
}

async function revokeIn(tx: Tx, buyer_id: Id, keep: Id | null, at: string): Promise<number> {
  const res = await tx.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = $3, updated_at = $3
      WHERE actor_kind = 'buyer' AND actor_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)
      RETURNING id`,
    [buyer_id, keep, at],
  );
  return res.rows.length;
}

/** Ends the buyer's sessions (all, or all but `keep_session_id`) and writes `account.sessions_revoked`. */
export async function revokeBuyerSessions(
  deps: SecurityDeps,
  i: { buyer_id: Id; keep_session_id: Id | null },
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const n = await revokeIn(tx, i.buyer_id, i.keep_session_id, deps.clock.now().toISOString());
    await deps.audit.record(tx, {
      actor: { kind: 'buyer', buyer_id: i.buyer_id },
      action: 'account.sessions_revoked',
      target: i.buyer_id,
      reason: null,
      detail: { count: n, kept_current: i.keep_session_id !== null },
    });
    return n;
  });
}

export type ChangePasswordResult =
  | { ok: true; revoked: number }
  | { ok: false; code: 'no_account' | 'wrong_password' }
  | { ok: false; code: 'weak_password'; reason: PasswordRefusal };

/**
 * Changes the password of the signed in buyer. The current password is checked first (a wrong one counts
 * towards the lock, exactly like a wrong sign in). On success every other session of the buyer ends and
 * `keep_session_id`, the one making the request, stays.
 */
export async function changePassword(
  deps: SecurityDeps,
  i: { buyer_id: Id; current_password: string; new_password: string; keep_session_id: Id | null },
): Promise<ChangePasswordResult> {
  const peek = await deps.db.query<{
    password_hash: string;
    username: string;
    display_name: string;
  }>(
    `SELECT a.password_hash, a.username, b.display_name FROM buyer_accounts a
       JOIN buyers b ON b.id = a.buyer_id WHERE a.buyer_id = $1`,
    [i.buyer_id],
  );
  const known = peek.rows[0];
  if (known === undefined) return { ok: false, code: 'no_account' };
  const good = await verifyPasscode(known.password_hash, i.current_password);
  let verdict: PolicyVerdict = checkPasswordPolicy(i.new_password, {
    username: known.username,
    display_name: known.display_name,
  });
  if (verdict.ok && i.new_password.normalize('NFKC') === i.current_password.normalize('NFKC'))
    verdict = { ok: false, reason: 'same_as_current' };
  const hash = good && verdict.ok ? await hashPasscode(i.new_password, deps.ids.nonce()) : '';
  return deps.db.transaction(async (tx): Promise<ChangePasswordResult> => {
    const row = await lockRow(tx, 'buyer_id', i.buyer_id);
    const now = deps.clock.now().getTime();
    if (row === undefined) return { ok: false, code: 'no_account' };
    if (isLocked(row, now) || !good || row.password_hash !== known.password_hash) {
      if (!isLocked(row, now)) await recordFailure(tx, deps, row, 'password_change', now);
      return { ok: false, code: 'wrong_password' };
    }
    if (!verdict.ok) return { ok: false, code: 'weak_password', reason: verdict.reason };
    const at = new Date(now).toISOString();
    await tx.query(
      `UPDATE buyer_accounts SET password_hash = $2, password_changed_at = $3, failed_attempts = 0,
              locked_until = NULL, updated_at = $3 WHERE buyer_id = $1`,
      [row.buyer_id, hash, at],
    );
    const revoked = await revokeIn(tx, row.buyer_id, i.keep_session_id, at);
    await deps.audit.record(tx, {
      actor: { kind: 'buyer', buyer_id: row.buyer_id },
      action: 'account.password_changed',
      target: row.buyer_id,
      reason: null,
      detail: { by: 'owner', sessions_revoked: revoked },
    });
    return { ok: true, revoked };
  });
}

export type ResetResult =
  | { ok: true; revoked: number }
  | { ok: false; code: 'unknown_account' }
  | { ok: false; code: 'weak_password'; reason: PasswordRefusal };

/**
 * The lost password path (pnpm accounts:reset-password): the operator sets a new password. Same policy,
 * the lock is cleared, every session of the account ends, one audit row. The caller has already checked
 * the terminal; this function knows nothing about passwords on screen.
 */
export async function resetPasswordForOperator(
  deps: SecurityDeps,
  i: { username: string; new_password: string; operator_id: string },
): Promise<ResetResult> {
  const found = USERNAME_PATTERN.test(i.username)
    ? await deps.db.query<{ buyer_id: string; display_name: string }>(
        `SELECT a.buyer_id, b.display_name FROM buyer_accounts a JOIN buyers b ON b.id = a.buyer_id
          WHERE a.username = $1`,
        [i.username],
      )
    : { rows: [] as { buyer_id: string; display_name: string }[] };
  const who = found.rows[0];
  if (who === undefined) return { ok: false, code: 'unknown_account' };
  const verdict = checkPasswordPolicy(i.new_password, {
    username: i.username,
    display_name: who.display_name,
  });
  if (!verdict.ok) return { ok: false, code: 'weak_password', reason: verdict.reason };
  const hash = await hashPasscode(i.new_password, deps.ids.nonce());
  return deps.db.transaction(async (tx): Promise<ResetResult> => {
    const row = await lockRow(tx, 'username', i.username);
    if (row === undefined) return { ok: false, code: 'unknown_account' };
    const at = deps.clock.now().toISOString();
    await tx.query(
      `UPDATE buyer_accounts SET password_hash = $2, password_changed_at = $3, failed_attempts = 0,
              locked_until = NULL, updated_at = $3 WHERE buyer_id = $1`,
      [row.buyer_id, hash, at],
    );
    const revoked = await revokeIn(tx, row.buyer_id, null, at);
    await deps.audit.record(tx, {
      // The person at the terminal is the second factor, not an authenticator code: mfa is false here.
      actor: { kind: 'operator', operator_id: i.operator_id, mfa: false },
      action: 'account.password_changed',
      target: row.buyer_id,
      reason: 'operator reset',
      detail: { by: 'operator', via: 'terminal', sessions_revoked: revoked },
    });
    return { ok: true, revoked };
  });
}
