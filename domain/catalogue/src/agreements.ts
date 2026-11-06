// The publisher terms record (AGREE-1, memo Q1 and Q27). A seeded, read only, append only row per demo
// publisher and terms version: terms_version, accepted_at, a demo label and the method seeded_demo. The
// boot seed is the only writer. There is no click-through and no publisher write; the functions here read
// the rows (a publisher its own, the operator with the second factor all). An applicant has no row.
// POB-P1 adds the click through: a publisher who claimed an account accepts the current version with a real
// action (acceptTerms), method publisher_accepted, labelled with their username.
import { err, ok } from '@umsbx/contracts';
import type { Actor, Clock, CoreDeps, Database, Ids, Result } from '@umsbx/contracts';
import { takeSeedLock } from './seed-lock';

export interface Agreement {
  publisher_id: string;
  terms_version: string;
  accepted_at: string;
  accepted_by_label: string;
  method: 'seeded_demo' | 'publisher_accepted';
}

export interface SeedAgreementsInput {
  terms_version: string;
  accepted_by_label: string;
  /** The demo publishers (by slug) that get a record. Other slugs and applicants get none. */
  publisher_slugs: readonly string[];
}

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

interface Row {
  publisher_id: string;
  terms_version: string;
  accepted_at: unknown;
  accepted_by_label: string;
  method: string;
}
const toAgreement = (r: Row): Agreement => ({
  publisher_id: r.publisher_id,
  terms_version: r.terms_version,
  accepted_at: iso(r.accepted_at),
  accepted_by_label: r.accepted_by_label,
  method: r.method === 'publisher_accepted' ? 'publisher_accepted' : 'seeded_demo',
});

/**
 * Boot seed. Gives each listed publisher that is not an applicant and has no record at all one record at the
 * given version. A publisher that already has a record is left alone, so a bumped version shows as "changed,
 * not re-accepted" instead of being accepted for the publisher. Returns the number of rows added; a second
 * run adds nothing.
 */
export async function seedAgreements(
  db: Database,
  clock: Clock,
  ids: Ids,
  input: SeedAgreementsInput,
): Promise<number> {
  if (input.publisher_slugs.length === 0) return 0;
  const now = clock.now().toISOString();
  return db.transaction(async (tx) => {
    // SEED-RACE: see seed-lock.ts.
    await takeSeedLock(tx);
    const todo = await tx.query<{ id: string }>(
      `SELECT p.id FROM publishers p
        WHERE p.slug = ANY ($1::text[]) AND p.status <> 'applied'
          AND NOT EXISTS (SELECT 1 FROM publisher_agreements a WHERE a.publisher_id = p.id)
        ORDER BY p.slug`,
      [[...input.publisher_slugs]],
    );
    for (const p of todo.rows) {
      await tx.query(
        `INSERT INTO publisher_agreements
           (id, publisher_id, terms_version, accepted_at, accepted_by_label, method, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'seeded_demo', $4, $4)`,
        [ids.next('aud'), p.id, input.terms_version, now, input.accepted_by_label],
      );
    }
    return todo.rows.length;
  });
}

const LATEST = `SELECT DISTINCT ON (publisher_id) publisher_id, terms_version, accepted_at, accepted_by_label, method
                  FROM publisher_agreements`;

/** The latest record of the publisher behind this actor, or null for any other actor and for no record. */
export async function ownAgreement(db: Database, actor: Actor): Promise<Agreement | null> {
  if (actor.kind !== 'publisher') return null;
  const r = await db.query<Row>(
    `${LATEST} WHERE publisher_id = $1 ORDER BY publisher_id, accepted_at DESC, id DESC`,
    [actor.publisher_id],
  );
  const row = r.rows[0];
  return row === undefined ? null : toAgreement(row);
}

/** The latest record of every publisher that has one. Null for any actor that is not an operator (a read: no code needed, OPS-A.7). */
export async function listAgreements(db: Database, operator: Actor): Promise<Agreement[] | null> {
  if (operator.kind !== 'operator') return null;
  const r = await db.query<Row>(`${LATEST} ORDER BY publisher_id, accepted_at DESC, id DESC`);
  return r.rows.map(toAgreement);
}

export type TermsDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'>;
export type TermsErrorCode = 'not_publisher' | 'no_account' | 'invalid_input' | 'already_accepted';
export interface TermsError {
  code: TermsErrorCode;
}
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

/**
 * The publisher accepts a version of the publisher terms. Needs a claimed account (the label is the username),
 * so a demo persona is refused. One record per publisher and version; a later version is a new row and the old
 * one stays. The version is the caller's (the web app's current version), 1 to 40 characters.
 */
export async function acceptTerms(
  deps: TermsDeps,
  actor: Actor,
  input: { terms_version: string },
): Promise<Result<{ terms_version: string; accepted_at: string }, TermsError>> {
  if (actor.kind !== 'publisher') return err({ code: 'not_publisher' });
  const version = typeof input.terms_version === 'string' ? input.terms_version.trim() : '';
  if (version.length < 1 || version.length > 40) return err({ code: 'invalid_input' });
  const at = deps.clock.now().toISOString();
  const publisher_id = actor.publisher_id;
  return deps.db.transaction(async (tx) => {
    const acct = await tx.query<{ username: string }>(
      'SELECT username FROM publisher_accounts WHERE publisher_id = $1 FOR UPDATE',
      [publisher_id],
    );
    const username = acct.rows[0]?.username;
    if (username === undefined) return err({ code: 'no_account' as const });
    const have = await tx.query(
      'SELECT 1 FROM publisher_agreements WHERE publisher_id = $1 AND terms_version = $2',
      [publisher_id, version],
    );
    if (have.rows.length > 0) return err({ code: 'already_accepted' as const });
    try {
      await tx.query(
        `INSERT INTO publisher_agreements
           (id, publisher_id, terms_version, accepted_at, accepted_by_label, method, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'publisher_accepted', $4, $4)`,
        [deps.ids.next('aud'), publisher_id, version, at, username],
      );
    } catch (e) {
      if (isUniqueViolation(e)) return err({ code: 'already_accepted' as const });
      throw e;
    }
    await deps.audit.record(tx, {
      actor,
      action: 'publisher.terms_accepted',
      target: publisher_id,
      reason: null,
      detail: { terms_version: version },
    });
    return ok({ terms_version: version, accepted_at: at });
  });
}
