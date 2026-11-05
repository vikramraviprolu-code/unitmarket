// The publisher terms record (AGREE-1, memo Q1 and Q27). A seeded, read only, append only row per demo
// publisher and terms version: terms_version, accepted_at, a demo label and the method seeded_demo. The
// boot seed is the only writer. There is no click-through and no publisher write; the functions here read
// the rows (a publisher its own, the operator with the second factor all). An applicant has no row.
import type { Actor, Clock, Database, Ids } from '@umsbx/contracts';
import { takeSeedLock } from './seed-lock';

export interface Agreement {
  publisher_id: string;
  terms_version: string;
  accepted_at: string;
  accepted_by_label: string;
  method: 'seeded_demo';
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
  method: 'seeded_demo',
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
