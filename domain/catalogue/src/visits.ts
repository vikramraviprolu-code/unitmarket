// The visit cursor of a publisher (PUB-E1, "Since your last visit"): one row per publisher in
// publisher_visits (migration 0013). It remembers when the publisher last opened its home page and the
// instant the page counts changes from. The only writer of that table, and only for the actor's own row.
//
// A visit more than the gap after the last one is a new visit: the instant to count from becomes the
// previous last seen time. A visit inside the gap (a refresh, a second tab) keeps the instant, so the list
// does not empty itself. The first visit stores a row and has nothing to count from (null). Nothing is
// ever deleted.
import type { Actor, Database, SqlExecutor } from '@umsbx/contracts';

/** Thirty minutes without a visit makes the next one a new visit. */
export const VISIT_GAP_MS = 30 * 60_000;

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

/**
 * Records a visit at `now` (an ISO instant from the injected clock) for the signed-in publisher and returns
 * the instant to count from, or null for the first visit. Null (and no write) for any other actor kind and
 * for a publisher id that names no row.
 */
export async function touchVisit(
  db: Database,
  actor: Actor,
  now: string,
): Promise<{ since: string | null } | null> {
  if (actor.kind !== 'publisher') return null;
  const id = actor.publisher_id;
  return db.transaction(async (tx: SqlExecutor) => {
    const known = await tx.query('SELECT 1 AS x FROM publishers WHERE id = $1', [id]);
    if (known.rows.length === 0) return null;
    const fresh = await tx.query(
      `INSERT INTO publisher_visits (publisher_id, since_at, last_seen_at, created_at, updated_at)
       VALUES ($1, NULL, $2, $2, $2) ON CONFLICT (publisher_id) DO NOTHING RETURNING publisher_id`,
      [id, now],
    );
    if (fresh.rows.length > 0) return { since: null };
    const cur = await tx.query<{ since_at: unknown; last_seen_at: unknown }>(
      'SELECT since_at, last_seen_at FROM publisher_visits WHERE publisher_id = $1 FOR UPDATE',
      [id],
    );
    const row = cur.rows[0];
    if (row === undefined) return { since: null };
    const last = iso(row.last_seen_at);
    const newVisit = Date.parse(now) - Date.parse(last) >= VISIT_GAP_MS;
    const since = newVisit ? last : row.since_at == null ? null : iso(row.since_at);
    await tx.query(
      `UPDATE publisher_visits SET since_at = $2, last_seen_at = $3, updated_at = $3 WHERE publisher_id = $1`,
      [id, since, now],
    );
    return { since };
  });
}
