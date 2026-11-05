// Publisher applicants (PUB-E2, decisions D-041, D-051; proposal 3A and 3I). The operator, with the second
// factor, adds an applicant (a publishers row with status applied, no payee, no offers), then approves it
// (applied to active) or rejects it. The 0012 CHECK has no rejected status, so a rejection is a row in
// publisher_applicant_decisions and the publisher stays applied. One decision per applicant. This is not
// signup: nobody creates an account by themselves, and an approved applicant has no sign in until the owners
// add a persona. Orders, units, access, approvals and the ledger are never touched. One audit row per change.
// PUB-APPLY adds the one public way in: submitApplication, callable with no actor, which creates the same kind
// of applicant row and nothing else (no account, no payee, no offer, no sign in).
import { err, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, Database, Id, Result, SqlExecutor } from '@umsbx/contracts';

export type ApplicantDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'>;

export type ApplicantErrorCode =
  | 'not_operator'
  | 'mfa_required'
  | 'invalid_input'
  | 'invalid_slug'
  | 'slug_taken'
  | 'not_found'
  | 'not_allowed'
  | 'already_decided'
  | 'busy';
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
  /** The note the applicant or the operator gave when the record was made, or null (seeded or older records). */
  note: string | null;
  /** Who made the record, read from its audit row: the public form, an operator, or null when no audit row says. */
  source: 'public' | 'operator' | null;
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

/**
 * The one INSERT of an applicant, shared by the operator's add and the public application: a publishers row with
 * status applied, no payee and no offers. A taken slug is `slug_taken`. The caller records the audit row.
 */
async function insertApplicant(
  tx: SqlExecutor,
  r: { id: Id; slug: string; name: string; country: string; at: string },
): Promise<void> {
  try {
    await tx.query(
      `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'applied', $5, $5)`,
      [r.id, r.slug, r.name, r.country, r.at],
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new Refused('slug_taken');
    throw e;
  }
}

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
      await insertApplicant(tx, { id: publisher_id, slug, name, country: input.country, at });
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

/** The applicants waiting or turned down, oldest first. Null for any actor that is not an operator (a read: no code needed, OPS-A.7). */
export async function listApplicants(db: Database, operator: Actor): Promise<Applicant[] | null> {
  if (operator.kind !== 'operator') return null;
  const r = await db.query<{
    id: string;
    slug: string;
    display_name: string;
    country: string;
    created_at: unknown;
    decision: string | null;
    reason: string | null;
    note: string | null;
    made_by: string | null;
  }>(
    `SELECT p.id, p.slug, p.display_name, p.country, p.created_at, d.decision, d.reason,
            (SELECT a.reason FROM audit_log a
              WHERE a.target = p.id
                AND (a.action = 'publisher.applicant_added'
                     OR (a.action = 'publisher.application_submitted' AND a.detail->>'actor' = 'anonymous'))
              ORDER BY a.created_at, a.id LIMIT 1) AS note,
            (SELECT a.action FROM audit_log a
              WHERE a.target = p.id
                AND (a.action = 'publisher.applicant_added'
                     OR (a.action = 'publisher.application_submitted' AND a.detail->>'actor' = 'anonymous'))
              ORDER BY a.created_at, a.id LIMIT 1) AS made_by
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
    // A record no audit row speaks for shows neither a source nor a note.
    note: x.made_by === null ? null : x.note,
    source:
      x.made_by === 'publisher.application_submitted'
        ? 'public'
        : x.made_by === 'publisher.applicant_added'
          ? 'operator'
          : null,
  }));
}

// ---------------------------------------------------------------------------------------------------------
// PUB-APPLY: the public application. Nobody is signed in, so there is no actor. It records an applicant and
// nothing else: no account, no sign in, no payee, no offer, no access. The operator sees it in the same list
// and answers it with decideApplicant. No new table: the note is the audit reason of the one audit row.
// ---------------------------------------------------------------------------------------------------------

/**
 * Pending public applications of the last 24 hours at which a new application is refused with `busy`. Only
 * the public form's own records in that window count, so the cap heals itself and operator work never
 * closes the form.
 */
export const APPLICATION_CAP = 200;
/** Put in front of the stored note when the name equals an existing publisher name (NFKC, case and spacing folded). */
export const DUPLICATE_NOTE_PREFIX = 'DUPLICATE NAME: ';
/** The audit actor of a public application. audit_log has no anonymous kind (and there is no new migration),
 * so the row carries the system actor and detail.actor = 'anonymous'. */
export const ANONYMOUS_APPLICATION_ACTOR: Actor = { kind: 'system' };
/** The caller's random part of the reference: 12 lowercase hex characters (48 bits, from Ids.nonce()). */
export const REF_NONCE_PATTERN = /^[0-9a-f]{12}$/;
const SLUG_BASE_MAX = 27;
const APPLICATION_ACTION = 'publisher.application_submitted';

const DAY_MS = 86_400_000;
// Invisible, bidirectional and layout characters are never part of a name or a note: control (Cc), format (Cf,
// which holds zero width, joiner and bidi marks), line and paragraph separators, the Hangul and halfwidth
// fillers, and the variation selectors.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u3164\u115F\u1160\uFFA0]|\p{Variation_Selector}/u;
const foldName = (v: string): string =>
  v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export type ApplicationState = 'pending' | 'approved' | 'rejected' | 'unavailable' | 'unknown';

/**
 * The checked form of an application, or null. The name is trimmed; the note has every run of whitespace
 * (line breaks and tabs too) turned into one space before the length check, so it is always one line.
 */
export function checkApplicationInput(input: {
  display_name: unknown;
  country: unknown;
  note: unknown;
  ref_nonce: unknown;
}): { name: string; country: string; note: string; ref_nonce: string } | null {
  const name = typeof input.display_name === 'string' ? input.display_name.trim() : '';
  const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
  if (
    name.length < 2 ||
    name.length > 80 ||
    hasBadChar(name) ||
    INVISIBLE.test(name) ||
    name.includes('<') ||
    name.includes('>') ||
    typeof input.country !== 'string' ||
    !COUNTRY_PATTERN.test(input.country) ||
    note.length < 3 ||
    note.length > 200 ||
    hasBadChar(note) ||
    INVISIBLE.test(note) ||
    typeof input.ref_nonce !== 'string' ||
    !REF_NONCE_PATTERN.test(input.ref_nonce)
  ) {
    return null;
  }
  return { name, country: input.country, note, ref_nonce: input.ref_nonce };
}

/** ASCII lowercase of the name, runs of other characters as single hyphens, at most 27 chars, never empty. */
export function slugBase(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const base = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/g, '');
  return base === '' ? 'applicant' : base;
}

/** The reference shown to the applicant, which is the slug: base, a hyphen and the 12 hex chars. */
export const applicationReference = (name: string, ref_nonce: string): string =>
  `${slugBase(name)}-${ref_nonce}`;

/**
 * Leave one application. Returns the reference (the slug), never an internal id. A name equal to an existing
 * publisher name is still accepted, with DUPLICATE_NOTE_PREFIX in front of the stored note.
 */
export async function submitApplication(
  deps: ApplicantDeps,
  input: { display_name: string; country: string; note: string; ref_nonce: string },
): Promise<Result<{ reference: string }, ApplicantError>> {
  const checked = checkApplicationInput(input);
  if (checked === null) return fail('invalid_input');
  const { name, note, country } = checked;
  const slug = applicationReference(name, checked.ref_nonce);
  try {
    return await deps.db.transaction(async (tx) => {
      const since = new Date(deps.clock.now().getTime() - DAY_MS).toISOString();
      const pending = await tx.query<{ c: string | number }>(
        `SELECT count(*) AS c FROM publishers p
          WHERE p.status = 'applied'
            AND p.created_at > $1
            AND NOT EXISTS (SELECT 1 FROM publisher_applicant_decisions d WHERE d.publisher_id = p.id)
            AND EXISTS (SELECT 1 FROM audit_log a
                         WHERE a.target = p.id AND a.action = $2 AND a.detail->>'actor' = 'anonymous')`,
        [since, APPLICATION_ACTION],
      );
      if (Number(pending.rows[0]?.c ?? 0) >= APPLICATION_CAP) throw new Refused('busy');
      // A reused nonce is refused as busy; the caller draws a new one. It says nothing about other slugs.
      const taken = await tx.query('SELECT 1 FROM publishers WHERE slug = $1', [slug]);
      if (taken.rows.length > 0) throw new Refused('busy');
      const mine = foldName(name);
      const names = await tx.query<{ display_name: string }>('SELECT display_name FROM publishers');
      const same = names.rows.some((r) => foldName(r.display_name) === mine);
      const stored = same ? `${DUPLICATE_NOTE_PREFIX}${note}` : note;
      const at = deps.clock.now().toISOString();
      const publisher_id = deps.ids.next('pub');
      try {
        await insertApplicant(tx, { id: publisher_id, slug, name, country, at });
      } catch (e) {
        if (e instanceof Refused && e.code === 'slug_taken') throw new Refused('busy');
        throw e;
      }
      await deps.audit.record(tx, {
        actor: ANONYMOUS_APPLICATION_ACTOR,
        action: APPLICATION_ACTION,
        target: publisher_id,
        reason: stored,
        detail: { actor: 'anonymous', source: 'public_application', slug, country },
      });
      return ok({ reference: slug });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * Where an application stands, from the reference alone. Only a record made by submitApplication answers:
 * a seeded publisher, an operator added applicant or a guess all read `unknown`, so this is no way to look up
 * who exists. Returns nothing but the state word.
 */
export async function applicationStatus(db: Database, ref: string): Promise<ApplicationState> {
  if (typeof ref !== 'string' || ref.length < 3 || ref.length > 40 || !SLUG_PATTERN.test(ref)) {
    return 'unknown';
  }
  const r = await db.query<{ status: string; decision: string | null }>(
    `SELECT p.status, d.decision
       FROM publishers p
       LEFT JOIN publisher_applicant_decisions d ON d.publisher_id = p.id
      WHERE p.slug = $1
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.target = p.id AND a.action = $2)`,
    [ref, APPLICATION_ACTION],
  );
  const row = r.rows[0];
  if (row === undefined) return 'unknown';
  // A suspended publisher is not shown as approved: the applicant is told only that it is not available.
  if (row.status === 'suspended') return 'unavailable';
  if (row.decision === 'rejected') return 'rejected';
  if (row.decision === 'approved' || row.status === 'active') return 'approved';
  return 'pending';
}
