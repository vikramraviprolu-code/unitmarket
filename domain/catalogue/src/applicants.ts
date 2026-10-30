// Publisher applicants (PUB-E2, decisions D-041, D-051; proposal 3A and 3I). The operator, with the second
// factor, adds an applicant (a publishers row with status applied, no payee, no offers), then approves it
// (applied to active) or rejects it. The 0012 CHECK has no rejected status, so a rejection is a row in
// publisher_applicant_decisions and the publisher stays applied. One decision per applicant. This is not
// signup: nobody creates an account by themselves, and an approved applicant has no sign in until the owners
// add a persona. Orders, units, access, approvals and the ledger are never touched. One audit row per change.
import { err, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Database, Id, Result } from '@umsbx/contracts';

export type ApplicantDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'>;

export type ApplicantErrorCode =
  | 'not_operator'
  | 'mfa_required'
  | 'invalid_input'
  | 'invalid_slug'
  | 'slug_taken'
  | 'not_found'
  | 'not_allowed'
  | 'already_decided';
export interface ApplicantError {
  code: ApplicantErrorCode;
}

export type ApplicantState = 'pending' | 'rejected';
export interface Applicant {
  publisher_id: Id;
  slug: string;
  display_name: string;
  country: string;
  state: ApplicantState;
  added_at: string;
  /** The operator's reason when the applicant was rejected, otherwise null. */
  decision_reason: string | null;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
// Control, zero width and bidirectional control characters are never part of a name.
const hasBadChar = (v: string): boolean => {
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200d) ||
      c === 0x2060 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff
    )
      return true;
  }
  return false;
};

const fail = (code: ApplicantErrorCode): Result<never, ApplicantError> => err({ code });

class Refused extends Error {
  // Declared field, not a parameter property: the offline scripts run this file in Node's strip-only mode.
  readonly code: ApplicantErrorCode;
  constructor(code: ApplicantErrorCode) {
    super(code);
    this.code = code;
  }
}
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

function gate(operator: Actor): Result<never, ApplicantError> | null {
  if (operator.kind !== 'operator') return fail('not_operator');
  if (!operator.mfa) return fail('mfa_required');
  return null;
}
const reasonOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  return r.length >= 3 && r.length <= 200 ? r : null;
};

/** Add one applicant. Returns the new publisher id; the publisher is applied and cannot sign in or sell. */
export async function addApplicant(
  deps: ApplicantDeps,
  operator: Actor,
  input: { slug: string; display_name: string; country: string; reason: string },
): Promise<Result<{ publisher_id: Id }, ApplicantError>> {
  const g = gate(operator);
  if (g !== null) return g;
  const slug = input.slug;
  if (typeof slug !== 'string' || slug.length < 3 || slug.length > 40 || !SLUG_PATTERN.test(slug)) {
    return fail('invalid_slug');
  }
  const name = typeof input.display_name === 'string' ? input.display_name.trim() : '';
  const reason = reasonOf(input.reason);
  if (
    name.length < 2 ||
    name.length > 80 ||
    hasBadChar(name) ||
    typeof input.country !== 'string' ||
    !COUNTRY_PATTERN.test(input.country) ||
    reason === null
  ) {
    return fail('invalid_input');
  }
  try {
    return await deps.db.transaction(async (tx) => {
      const taken = await tx.query('SELECT 1 FROM publishers WHERE slug = $1', [slug]);
      if (taken.rows.length > 0) throw new Refused('slug_taken');
      const at = deps.clock.now().toISOString();
      const publisher_id = deps.ids.next('pub');
      try {
        await tx.query(
          `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'applied', $5, $5)`,
          [publisher_id, slug, name, input.country, at],
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw new Refused('slug_taken');
        throw e;
      }
      await deps.audit.record(tx, {
        actor: operator,
        action: 'publisher.applicant_added',
        target: publisher_id,
        reason,
        detail: { slug, country: input.country },
      });
      return ok({ publisher_id });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * Approve (applied to active) or reject (stays applied, decision recorded) one applicant. Only an applied
 * publisher with no decision yet; active and suspended publishers are not_allowed and keep their status.
 */
export async function decideApplicant(
  deps: ApplicantDeps,
  operator: Actor,
  input: { publisher_id: Id; decision: 'approve' | 'reject'; reason: string },
): Promise<Result<{ state: 'active' | 'rejected' }, ApplicantError>> {
  const g = gate(operator);
  if (g !== null) return g;
  const reason = reasonOf(input.reason);
  if (
    reason === null ||
    (input.decision !== 'approve' && input.decision !== 'reject') ||
    typeof input.publisher_id !== 'string' ||
    input.publisher_id.length === 0
  ) {
    return fail('invalid_input');
  }
  const approve = input.decision === 'approve';
  const operatorId = operator.kind === 'operator' ? operator.operator_id : '';
  try {
    return await deps.db.transaction(async (tx) => {
      // The row is locked, so two answers about one applicant take turns.
      const p = await tx.query<{ status: string }>(
        'SELECT status FROM publishers WHERE id = $1 FOR UPDATE',
        [input.publisher_id],
      );
      const current = p.rows[0]?.status;
      if (current === undefined) throw new Refused('not_found');
      if (current !== 'applied') throw new Refused('not_allowed');
      const done = await tx.query(
        'SELECT 1 FROM publisher_applicant_decisions WHERE publisher_id = $1',
        [input.publisher_id],
      );
      if (done.rows.length > 0) throw new Refused('already_decided');
      const at = deps.clock.now().toISOString();
      try {
        await tx.query(
          `INSERT INTO publisher_applicant_decisions (id, publisher_id, decision, operator_id, reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [
            deps.ids.next('aud'),
            input.publisher_id,
            approve ? 'approved' : 'rejected',
            operatorId,
            reason,
            at,
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw new Refused('already_decided');
        throw e;
      }
      if (approve) {
        await tx.query("UPDATE publishers SET status = 'active', updated_at = $2 WHERE id = $1", [
          input.publisher_id,
          at,
        ]);
      }
      await deps.audit.record(tx, {
        actor: operator,
        action: approve ? 'publisher.applicant_approved' : 'publisher.applicant_rejected',
        target: input.publisher_id,
        reason,
        detail: { from: 'applied', to: approve ? 'active' : 'applied' },
      });
      return ok({ state: approve ? ('active' as const) : ('rejected' as const) });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/** The applicants waiting or turned down, oldest first. Null for any actor that is not an operator with MFA. */
export async function listApplicants(db: Database, operator: Actor): Promise<Applicant[] | null> {
  if (operator.kind !== 'operator' || !operator.mfa) return null;
  const r = await db.query<{
    id: string;
    slug: string;
    display_name: string;
    country: string;
    created_at: unknown;
    decision: string | null;
    reason: string | null;
  }>(
    `SELECT p.id, p.slug, p.display_name, p.country, p.created_at, d.decision, d.reason
       FROM publishers p
       LEFT JOIN publisher_applicant_decisions d ON d.publisher_id = p.id
      WHERE p.status = 'applied'
      ORDER BY p.created_at, p.id`,
  );
  return r.rows.map((x) => ({
    publisher_id: x.id,
    slug: x.slug,
    display_name: x.display_name,
    country: x.country,
    state: x.decision === 'rejected' ? 'rejected' : 'pending',
    added_at: iso(x.created_at),
    decision_reason: x.decision === 'rejected' ? x.reason : null,
  }));
}
