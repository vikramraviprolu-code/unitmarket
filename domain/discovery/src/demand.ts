// CAT-2.5: buyer demand, shown to buyers as "Popular requests" and to publishers as "What buyers ask for".
// Privacy first: a term surfaces only when MIN_BUYERS or more distinct buyers asked for it in a closed 30 day
// window that ends at the start of the UTC day, and offers with that topic exist at two publishers or more. The
// answer is a term and a band, never an exact count, a buyer id, a brief id or raw text. Owned by SBX.
import type { SqlExecutor } from '@umsbx/contracts';

/** Buyers needed before a term is shown. A constant, not a parameter: no caller can lower it. */
export const MIN_BUYERS = 5;
const WINDOW_DAYS = 30;
const FRESH_BUYER_DAYS = 7;
const MIN_PUBLISHERS = 2;
const DAY_MS = 86_400_000;
// A term is lower-cased and trimmed, then dropped whole unless it is 3 to 40 letters, digits or spaces. Postgres
// regex has no \p, so this runs here, after the read.
const TERM_PATTERN = /^[\p{L}\p{N} ]{3,40}$/u;
// A raw element longer than this is not read at all (it could not pass the filter after trimming in any case a
// publisher or buyer would type).
const MAX_RAW_CHARS = 1000;

export type DemandBand = '5-9' | '10-49' | '50+';
export interface DemandTerm {
  term: string;
  band: DemandBand;
}
export interface PublisherDemand extends DemandTerm {
  matching: number;
}

const bandOf = (buyers: number): DemandBand =>
  buyers >= 50 ? '50+' : buyers >= 10 ? '10-49' : '5-9';
const BAND_RANK: Record<DemandBand, number> = { '50+': 2, '10-49': 1, '5-9': 0 };
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// A current authorised offer of an active publisher (the CAT-1 guards, without a corridor).
const CURRENT = `o.status = 'authorised' AND o.superseded_by IS NULL AND p.status = 'active'
  AND EXISTS (SELECT 1 FROM publisher_authorisations pa WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
  AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND (n.created_at, n.version) > (o.created_at, o.version))`;

export async function demandTerms(
  db: SqlExecutor,
  i: { day: Date; limit: number },
): Promise<DemandTerm[]> {
  const limit = Math.max(0, Math.min(50, Math.trunc(i.limit) || 0));
  if (limit === 0) return [];
  const end = i.day.getTime();
  const from = new Date(end - WINDOW_DAYS * DAY_MS).toISOString();
  const fresh = new Date(end - FRESH_BUYER_DAYS * DAY_MS).toISOString();
  const to = new Date(end).toISOString();
  // Only string elements of a terms array are read; any other shape is skipped by the SQL itself.
  const { rows } = await db.query<{ buyer_id: string; term: string }>(
    `SELECT DISTINCT b.buyer_id, e.value #>> '{}' AS term
       FROM briefs b
       JOIN buyers u ON u.id = b.buyer_id
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(b.structured -> 'terms') = 'array' THEN b.structured -> 'terms' ELSE '[]'::jsonb END
       ) AS e(value)
      WHERE b.created_at >= $1::timestamptz AND b.created_at < $2::timestamptz
        AND u.created_at < $3::timestamptz
        AND jsonb_typeof(e.value) = 'string' AND length(e.value #>> '{}') <= ${MAX_RAW_CHARS}`,
    [from, to, fresh],
  );
  const buyers = new Map<string, Set<string>>();
  for (const r of rows) {
    const term = r.term.trim().toLowerCase();
    if (!TERM_PATTERN.test(term)) continue;
    const s = buyers.get(term) ?? new Set<string>();
    s.add(r.buyer_id);
    buyers.set(term, s);
  }
  const asked = [...buyers].filter(([, s]) => s.size >= MIN_BUYERS).map(([t]) => t);
  if (asked.length === 0) return [];
  // The term must be a whole word of a topic at MIN_PUBLISHERS different publishers.
  const spread = await db.query<{ term: string }>(
    `SELECT w.term
       FROM unnest($1::text[]) AS w(term)
       JOIN LATERAL (
         SELECT count(DISTINCT o.publisher_id) AS n
           FROM offers o
           JOIN articles a ON a.id = o.article_id
           JOIN publishers p ON p.id = o.publisher_id
          WHERE ${CURRENT}
            AND EXISTS (SELECT 1 FROM unnest(a.topics) t WHERE t ~* ('\\m' || w.term || '\\M'))
       ) c ON c.n >= $2
      ORDER BY w.term`,
    [asked, MIN_PUBLISHERS],
  );
  const shown = spread.rows.map((r) => r.term);
  return shown
    .map((term) => ({ term, band: bandOf(buyers.get(term)!.size) }))
    .sort((a, b) => BAND_RANK[b.band] - BAND_RANK[a.band] || byCodeUnit(a.term, b.term))
    .slice(0, limit);
}

/** The same terms with how many of this publisher's current authorised offers have that topic. */
export async function demandForPublisher(
  db: SqlExecutor,
  publisher_id: string,
  terms: readonly DemandTerm[],
): Promise<PublisherDemand[]> {
  if (terms.length === 0) return [];
  const { rows } = await db.query<{ term: string; n: string | number }>(
    `SELECT w.term, count(DISTINCT o.id) AS n
       FROM unnest($2::text[]) AS w(term)
       LEFT JOIN LATERAL (
         SELECT o.id
           FROM offers o
           JOIN articles a ON a.id = o.article_id
           JOIN publishers p ON p.id = o.publisher_id
          WHERE o.publisher_id = $1 AND ${CURRENT}
            AND EXISTS (SELECT 1 FROM unnest(a.topics) t WHERE t ~* ('\\m' || w.term || '\\M'))
       ) o ON true
      GROUP BY w.term`,
    [publisher_id, terms.map((t) => t.term)],
  );
  const n = new Map(rows.map((r) => [r.term, Number(r.n)]));
  return terms.map((t) => ({ term: t.term, band: t.band, matching: n.get(t.term) ?? 0 }));
}
