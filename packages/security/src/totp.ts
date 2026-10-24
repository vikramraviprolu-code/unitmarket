// Operator TOTP (CO-6, RFC 6238 over node:crypto, no library): HMAC-SHA1, 30 s step, 6 digits.
// The current step and one either side are accepted. Every candidate is compared with
// timingSafeEqual and none returns early. A step an operator has already used is refused: the
// used step is an `operator.totp_used` audit_log row, read back before a code is accepted, so no
// table is added. Keys come from config (UMS_OPERATOR_TOTP_KEYS) as Secrets; this file never logs
// or stores a key or a code.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Id, Secret } from '@umsbx/contracts';
import { resetBucket, takeToken, type RateRule } from './rate';
import type { SecurityDeps } from './route';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted on either side of the current one (clock skew). */
export const TOTP_WINDOW = 1;
export const TOTP_MIN_KEY_BYTES = 20;
export const TOTP_ISSUER = 'UnitMarket Sandbox';
export const TOTP_USED_ACTION = 'operator.totp_used';

/** Operator names in UMS_OPERATOR_TOTP_KEYS. packages/config repeats this shape (it may not import this package). */
export const OPERATOR_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** The id of an operator session that has not shown a second factor; no key may be named after it. */
export const UNVERIFIED_OPERATOR_ID: Id = 'opr_demo';
const UNVERIFIED_NAME = 'demo';

export const isOperatorName = (name: string): boolean =>
  OPERATOR_NAME.test(name) && name !== UNVERIFIED_NAME;

/**
 * Wrong codes for one operator. The sign-in route already limits attempts per client address and
 * persona (5 per 15 min), but a sign-in without a code succeeds and resets that bucket, so it alone
 * would not stop a guesser who alternates. This bucket belongs to the operator, is spent before a code
 * is checked and is given back only by a right code.
 */
export const TOTP_FAIL_RULE: RateRule = {
  name: 'totp-fail',
  per: 'actor',
  limit: 5,
  window_ms: 15 * 60_000,
};

// ---------------------------------------------------------------------------------------------
// base32 (RFC 4648), the form authenticator apps take
// ---------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Unpadded upper case base32. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

// Characters left over after whole 8-character groups, and the padding that group needs.
const PADDING_FOR: Record<number, number> = { 0: 0, 2: 6, 4: 4, 5: 3, 7: 1 };

/** The bytes of a base32 text (any case, padding optional), or null when it is not valid base32. */
export function base32Decode(text: string): Buffer | null {
  if (text.length === 0 || text.length > 256) return null;
  const m = /^([A-Za-z2-7]+)(={0,6})$/.exec(text);
  if (m === null) return null;
  const body = (m[1] ?? '').toUpperCase();
  const pad = (m[2] ?? '').length;
  const want = PADDING_FOR[body.length % 8];
  if (want === undefined) return null;
  if (pad !== 0 && pad !== want) return null;
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const c of body) {
    acc = (acc << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------------------------
// RFC 6238 / RFC 4226
// ---------------------------------------------------------------------------------------------
export const stepAt = (ms: number): number => Math.floor(ms / (TOTP_STEP_SECONDS * 1000));

/** The code of one step (the HOTP counter is the step). */
export function totpCode(key: Uint8Array, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

const CODE = /^[0-9]{6}$/;

/** The typed code without spaces, or null when it is not six ASCII digits. */
function typedCode(raw: string): string | null {
  if (raw.length > 32) return null;
  const t = raw.replace(/ /g, '');
  return CODE.test(t) ? t : null;
}

/**
 * The steps of the window whose code equals `code`. All three candidates are compared, in the same
 * way and with timingSafeEqual, whatever the answer. Only a text that is not six digits is refused
 * early, and that needs no secret to decide.
 */
export function matchingSteps(key: Uint8Array, code: string, nowMs: number): number[] {
  const typed = typedCode(code);
  if (typed === null) return [];
  const want = Buffer.from(typed, 'ascii');
  const now = stepAt(nowMs);
  const hits: number[] = [];
  for (const step of [now, now - TOTP_WINDOW, now + TOTP_WINDOW]) {
    // There is no step before the first; compare against the current one so the work stays the same.
    const real = step >= 0;
    const expected = Buffer.from(totpCode(key, real ? step : now), 'ascii');
    if (timingSafeEqual(expected, want) && real) hits.push(step);
  }
  return hits;
}

/** The URI an authenticator app scans or imports (Key URI Format). */
export function otpauthUri(operator: string, secret_b32: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  return `otpauth://totp/${issuer}:${encodeURIComponent(operator)}?secret=${secret_b32}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ---------------------------------------------------------------------------------------------
// acceptance: window, replay record, failure bucket
// ---------------------------------------------------------------------------------------------
export type TotpDeps = Pick<SecurityDeps, 'db' | 'clock' | 'audit' | 'log'>;
export type TotpVerdict = 'accepted' | 'wrong' | 'replay' | 'locked';

/**
 * Checks one code for one operator. A token of the operator's failure bucket is spent first (no token:
 * `locked`, nothing is checked). A code inside the window is then accepted only if its step is not yet
 * an `operator.totp_used` row; the check and the row are one transaction under a per-operator advisory
 * lock, so two sign-ins with the same code cannot both pass. A right code gives the tokens back.
 */
export async function acceptTotp(
  deps: TotpDeps,
  i: { operator_id: Id; key: Secret; code: string },
): Promise<TotpVerdict> {
  const token = await takeToken(deps, TOTP_FAIL_RULE, i.operator_id);
  if (!token.allowed) return 'locked';
  const key = base32Decode(i.key.reveal());
  // Config refuses a short key at boot; a broken Secret here fails closed.
  if (key === null || key.length < TOTP_MIN_KEY_BYTES) return 'wrong';
  const steps = matchingSteps(key, i.code, deps.clock.now().getTime());
  if (steps.length === 0) return 'wrong';
  const verdict = await deps.db.transaction(async (tx): Promise<'accepted' | 'replay'> => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`totp:${i.operator_id}`]);
    for (const step of steps) {
      const used = await tx.query(
        `SELECT 1 FROM audit_log
          WHERE action = $1 AND actor_kind = 'operator' AND actor_id = $2 AND detail->>'step' = $3
          LIMIT 1`,
        [TOTP_USED_ACTION, i.operator_id, String(step)],
      );
      if (used.rows.length > 0) continue;
      await deps.audit.record(tx, {
        actor: { kind: 'operator', operator_id: i.operator_id, mfa: true },
        action: TOTP_USED_ACTION,
        target: null,
        reason: null,
        detail: { step },
      });
      return 'accepted';
    }
    return 'replay';
  });
  if (verdict === 'accepted') await resetBucket(deps, TOTP_FAIL_RULE, i.operator_id);
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// the sign-in decision for the operator persona
// ---------------------------------------------------------------------------------------------
export type OperatorSignIn =
  | { ok: true; operator_id: Id; mfa: boolean }
  | { ok: false; reason: 'unknown_operator' | 'wrong_code' | 'replay' | 'locked' };

// A key nobody has, so an unknown name costs the same work as a known one.
const NO_KEY = Buffer.alloc(TOTP_MIN_KEY_BYTES, 1);

/**
 * Called after the passcode is right. With no keys configured, or no code typed, the operator signs
 * in as the unverified operator without mfa (can view and stop; cannot refund or turn a switch on).
 * A code needs a configured name; a right one gives `opr_<name>` with mfa. Only a verified second
 * factor ever names an operator: a session without one is never attributed to a person.
 */
export async function operatorSignIn(
  deps: TotpDeps,
  i: {
    keys: ReadonlyArray<{ name: string; key: Secret }>;
    operator?: string | undefined;
    code?: string | undefined;
  },
): Promise<OperatorSignIn> {
  const code = i.code ?? '';
  if (i.keys.length === 0 || code.replace(/ /g, '') === '')
    return { ok: true, operator_id: UNVERIFIED_OPERATOR_ID, mfa: false };
  const name = (i.operator ?? '').trim().toLowerCase();
  const entry = isOperatorName(name) ? i.keys.find((k) => k.name === name) : undefined;
  if (entry === undefined) {
    matchingSteps(NO_KEY, code, deps.clock.now().getTime());
    refused(deps, 'unknown_operator');
    return { ok: false, reason: 'unknown_operator' };
  }
  const operator_id: Id = `opr_${entry.name}`;
  const verdict = await acceptTotp(deps, { operator_id, key: entry.key, code });
  if (verdict === 'accepted') return { ok: true, operator_id, mfa: true };
  const reason = verdict === 'wrong' ? 'wrong_code' : verdict;
  refused(deps, reason, operator_id);
  return { ok: false, reason };
}

// One line per refusal: the reason and, for a known operator, who. Never the code, the key or the typed name.
function refused(deps: TotpDeps, reason: string, operator_id?: Id): void {
  deps.log.log({
    msg: 'operator_sign_in_refused',
    level: 'warn',
    fields: operator_id === undefined ? { reason } : { reason, operator_id },
  });
}
