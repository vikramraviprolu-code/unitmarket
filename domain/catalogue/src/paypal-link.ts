// The publisher's own PayPal address (POB-P1, decision D-089 item 1). UnitMarket never creates a PayPal account:
// a publisher who claimed an account types the email of their own PayPal Business account (requested), and an
// operator with the second factor marks it checked after typing it again in full (verified). A change by the
// publisher returns it to requested. The whole address is held in publisher_paypal_links and shown to its owner
// only; the operator list and every audit row carry the masked form (first letter and domain).
import { err, isSyntheticPayee, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Database, Id, Result } from '@umsbx/contracts';

// POB-G: `environment` is optional. Only 'dryrun' touches the payee columns of the publisher (see decidePaypalLink);
// a caller that does not say leaves them alone, which is the safe side.
export type LinkDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'> &
  Partial<Pick<CoreDeps, 'environment'>>;
export type LinkErrorCode =
  | 'not_publisher'
  | 'no_account'
  | 'invalid_email'
  | 'same_as_current'
  | 'not_operator'
  | 'mfa_required'
  | 'invalid_input'
  | 'not_found'
  | 'email_mismatch'
  | 'already_verified'
  | 'email_in_use';
export interface LinkError {
  code: LinkErrorCode;
}
export type PaypalLinkState = 'requested' | 'verified';
export interface PaypalLinkView {
  email: string;
  state: PaypalLinkState;
  verified_at: string | null;
  updated_at: string;
  /**
   * POB-DEMOLINK: present (true) only for a verified link that is the dry run seed's synthetic demo address, so a screen
   * never says an operator checked it. Absent for every other link.
   */
  synthetic?: true;
}

const fail = (code: LinkErrorCode): Result<never, LinkError> => err({ code });
class Refused extends Error {
  // Declared field, not a parameter property: the offline scripts run this file in Node's strip-only mode.
  readonly code: LinkErrorCode;
  constructor(code: LinkErrorCode) {
    super(code);
    this.code = code;
  }
}
// Only this index: the dry run payee update in the same transaction has a unique key of its own (merchant id).
const isVerifiedEmailViolation = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: unknown }).code === '23505' &&
  (e as { constraint?: unknown }).constraint === 'publisher_paypal_links_verified_email_key';
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
// Control and format characters (zero width, bidirectional marks, the byte order mark) are never part of an address.
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const EMAIL =
  /^[a-z0-9.!#$%&*+/=?^_{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The address as stored: trimmed and lower case; null for anything that is not one plain email address. */
export function normalizePaypalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string' || CONTROL.test(raw)) return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/** First letter, three stars and the domain: enough for an operator to recognise it, not to reuse it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email.slice(0, 1)}***${email.slice(at)}`;
}

const reasonOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  return r.length >= 3 && r.length <= 200 ? r : null;
};

/** The publisher's own address and its state. Null for any other actor and for no address. */
export async function ownPaypalLink(db: Database, actor: Actor): Promise<PaypalLinkView | null> {
  if (actor.kind !== 'publisher') return null;
  const r = await db.query<{
    paypal_email: string;
    state: PaypalLinkState;
    verified_by: string | null;
    verified_at: unknown;
    updated_at: unknown;
  }>(
    'SELECT paypal_email, state, verified_by, verified_at, updated_at FROM publisher_paypal_links WHERE publisher_id = $1',
    [actor.publisher_id],
  );
  const row = r.rows[0];
  return row === undefined
    ? null
    : {
        email: row.paypal_email,
        state: row.state,
        verified_at: row.verified_at == null ? null : iso(row.verified_at),
        updated_at: iso(row.updated_at),
        ...(row.state === 'verified' && isSyntheticPayee(row.paypal_email, row.verified_by)
          ? { synthetic: true as const }
          : {}),
      };
}

/**
 * The publisher enters or changes the address. Needs a claimed account. The same address again while it waits
 * changes nothing; the same address once checked is `same_as_current`; a different one is stored as requested.
 */
export async function requestPaypalLink(
  deps: LinkDeps,
  actor: Actor,
  input: { email: string },
): Promise<Result<{ state: 'requested' }, LinkError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const email = normalizePaypalEmail(input.email);
  if (email === null) return fail('invalid_email');
  const publisher_id = actor.publisher_id;
  try {
    return await deps.db.transaction(async (tx) => {
      const acct = await tx.query(
        'SELECT 1 FROM publisher_accounts WHERE publisher_id = $1 FOR UPDATE',
        [publisher_id],
      );
      if (acct.rows.length === 0) throw new Refused('no_account');
      const cur = await tx.query<{ paypal_email: string; state: PaypalLinkState }>(
        'SELECT paypal_email, state FROM publisher_paypal_links WHERE publisher_id = $1 FOR UPDATE',
        [publisher_id],
      );
      const row = cur.rows[0];
      if (row !== undefined && row.paypal_email === email) {
        if (row.state === 'verified') throw new Refused('same_as_current');
        return ok({ state: 'requested' as const });
      }
      const at = deps.clock.now().toISOString();
      // POB-G: a changed address needs a new operator check (P1), so in dry run the publisher is not buyable until then.
      // The synthetic label stays: it is not an account. Sandbox mode never reaches these columns from here.
      if (row !== undefined && deps.environment === 'dryrun')
        await tx.query(
          'UPDATE publishers SET payee_verified_at = NULL, updated_at = $2 WHERE id = $1 AND payee_verified_at IS NOT NULL',
          [publisher_id, at],
        );
      if (row === undefined)
        await tx.query(
          `INSERT INTO publisher_paypal_links
             (publisher_id, paypal_email, state, verified_by, verified_at, created_at, updated_at)
           VALUES ($1, $2, 'requested', NULL, NULL, $3, $3)`,
          [publisher_id, email, at],
        );
      else
        await tx.query(
          `UPDATE publisher_paypal_links
              SET paypal_email = $2, state = 'requested', verified_by = NULL, verified_at = NULL, updated_at = $3
            WHERE publisher_id = $1`,
          [publisher_id, email, at],
        );
      await deps.audit.record(tx, {
        actor,
        action: 'publisher.paypal_link_requested',
        target: publisher_id,
        reason: null,
        detail: { masked: maskEmail(email), changed: row !== undefined },
      });
      return ok({ state: 'requested' as const });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * An operator with the second factor marks the address as checked, after typing it again in full. A different
 * retyped address changes nothing. One decision per link: a checked link is `already_verified` until the
 * publisher changes it. One verified address belongs to one publisher (POB-LINKU): while another publisher's
 * link holds the same address as verified the answer is `email_in_use`, for the operator only (the publisher is
 * never told). The partial unique index `publisher_paypal_links_verified_email_key` is the last line: of two
 * operators verifying one address at once, the second waits on the index and gets 23505, which is the same answer.
 */
export async function decidePaypalLink(
  deps: LinkDeps,
  operator: Actor,
  input: { publisher_id: Id; email_retyped: string; reason: string },
): Promise<Result<{ state: 'verified' }, LinkError>> {
  if (operator.kind !== 'operator') return fail('not_operator');
  if (!operator.mfa) return fail('mfa_required');
  const reason = reasonOf(input.reason);
  if (
    reason === null ||
    typeof input.publisher_id !== 'string' ||
    input.publisher_id.length === 0 ||
    typeof input.email_retyped !== 'string'
  )
    return fail('invalid_input');
  const retyped = normalizePaypalEmail(input.email_retyped);
  try {
    return await deps.db.transaction(async (tx) => {
      const cur = await tx.query<{ paypal_email: string; state: PaypalLinkState }>(
        'SELECT paypal_email, state FROM publisher_paypal_links WHERE publisher_id = $1 FOR UPDATE',
        [input.publisher_id],
      );
      const row = cur.rows[0];
      if (row === undefined) throw new Refused('not_found');
      if (row.state === 'verified') throw new Refused('already_verified');
      if (retyped === null || retyped !== row.paypal_email) throw new Refused('email_mismatch');
      const held = await tx.query(
        `SELECT 1 FROM publisher_paypal_links
          WHERE state = 'verified' AND publisher_id <> $1 AND lower(btrim(paypal_email)) = $2
          LIMIT 1`,
        [input.publisher_id, row.paypal_email],
      );
      if (held.rows.length > 0) throw new Refused('email_in_use');
      const at = deps.clock.now().toISOString();
      await tx.query(
        `UPDATE publisher_paypal_links
            SET state = 'verified', verified_by = $2, verified_at = $3, updated_at = $3
          WHERE publisher_id = $1`,
        [input.publisher_id, operator.operator_id, at],
      );
      // POB-G (journey J6 to J10): in dry run the verified link makes the publisher buyable, in the same transaction. The
      // payee is the synthetic label the boot seed gives existing publishers (an id the buy path needs, not an account);
      // a merchant id the publisher already has is kept. Sandbox mode invents nothing: no merchant id, no verification
      // stamp, so the approval check (publisher_unverified) stays as it was until a real id exists.
      if (deps.environment === 'dryrun')
        await tx.query(
          `UPDATE publishers
              SET paypal_merchant_id = coalesce(paypal_merchant_id, 'DRYRUN' || upper(left(md5(slug), 7))),
                  payee_verified_at = $2, updated_at = $2
            WHERE id = $1 AND status = 'active' AND NOT payee_shared`,
          [input.publisher_id, at],
        );
      await deps.audit.record(tx, {
        actor: operator,
        action: 'publisher.paypal_link_verified',
        target: input.publisher_id,
        reason,
        detail: { masked: maskEmail(row.paypal_email) },
      });
      return ok({ state: 'verified' as const });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    if (isVerifiedEmailViolation(e)) return fail('email_in_use');
    throw e;
  }
}
