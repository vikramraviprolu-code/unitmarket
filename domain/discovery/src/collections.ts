// CAT-2.1: collections. A photo import of 1,000 files shows as a few named collections. The pure part picks, for
// each offer, the topic of its own with the highest count in its publisher; the SQL part reads the counts over
// all of a publisher's current authorised offers and the facts of the candidates. Owned by SBX.
import type { SqlExecutor } from '@umsbx/contracts';

export interface CollectionRow {
  offer_id: string;
  publisher_id: string;
  topics: readonly string[];
  mime: string;
}
/** publisher id -> topic -> number of the publisher's current authorised offers. The key '' counts offers with no topic. */
export type TopicCounts = ReadonlyMap<string, ReadonlyMap<string, number>>;
export interface Collection {
  name: string;
  size: number;
  cover_offer_id: string;
}

export const OTHER = 'other';
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const normTopic = (t: string): string => t.trim().toLowerCase();
const topicsOf = (r: CollectionRow): string[] => [
  ...new Set(r.topics.map(normTopic).filter((t) => t.length > 0)),
];

export function collectionsOf(
  rows: readonly CollectionRow[],
  topicCounts: TopicCounts,
): Map<string, Collection> {
  // Pass 1: the collection name of every offer.
  const named = rows.map((r) => {
    const own = topicsOf(r);
    const counts = topicCounts.get(r.publisher_id);
    let name = OTHER;
    let best = -1;
    for (const t of own.sort(byCodeUnit)) {
      const c = counts?.get(t) ?? 0;
      if (c > best) {
        best = c;
        name = t;
      }
    }
    return { row: r, name, empty: own.length === 0 };
  });
  // Pass 2: the cover of each collection among the given rows.
  const groups = new Map<string, typeof named>();
  for (const n of named) {
    const key = `${n.row.publisher_id}\u0000${n.name}`;
    const g = groups.get(key);
    if (g) g.push(n);
    else groups.set(key, [n]);
  }
  const noTopicRows = new Map<string, number>();
  for (const n of named)
    if (n.empty)
      noTopicRows.set(n.row.publisher_id, (noTopicRows.get(n.row.publisher_id) ?? 0) + 1);
  const out = new Map<string, Collection>();
  for (const g of groups.values()) {
    const ids = g.map((n) => n.row);
    const images = ids.filter((r) => r.mime.startsWith('image/'));
    const pool = images.length > 0 ? images : ids;
    const cover = pool.map((r) => r.offer_id).sort(byCodeUnit)[0]!;
    const { name } = g[0]!;
    const pub = g[0]!.row.publisher_id;
    const counts = topicCounts.get(pub);
    const size =
      name === OTHER ? (counts?.get('') ?? noTopicRows.get(pub) ?? 0) : (counts?.get(name) ?? 0);
    for (const n of g) out.set(n.row.offer_id, { name, size, cover_offer_id: cover });
  }
  return out;
}

// The guards of the CAT-1 read (listAuthorisedOffers), without the corridor: a current authorised offer of an
// active publisher.
const CURRENT = `o.status = 'authorised' AND o.superseded_by IS NULL AND p.status = 'active'
  AND EXISTS (SELECT 1 FROM publisher_authorisations pa WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
  AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND (n.created_at, n.version) > (o.created_at, o.version))`;

export async function collectionFacts(
  db: SqlExecutor,
  publisher_ids: readonly string[],
  offer_ids: readonly string[],
): Promise<{ rows: CollectionRow[]; topicCounts: Map<string, Map<string, number>> }> {
  const topicCounts = new Map<string, Map<string, number>>();
  if (publisher_ids.length === 0) return { rows: [], topicCounts };
  // Counted over ALL of a publisher's current authorised offers, not only the candidates. One count per offer
  // and topic, so a topic listed twice on one offer counts once.
  const counted = await db.query<{ publisher_id: string; topic: string; n: string | number }>(
    `SELECT x.publisher_id, x.topic, count(*) AS n
       FROM (SELECT DISTINCT o.id, o.publisher_id, lower(trim(t)) AS topic
               FROM offers o
               JOIN articles a ON a.id = o.article_id
               JOIN publishers p ON p.id = o.publisher_id
               CROSS JOIN LATERAL unnest(a.topics) AS t
              WHERE o.publisher_id = ANY ($1::text[]) AND ${CURRENT} AND trim(t) <> '') x
      GROUP BY x.publisher_id, x.topic`,
    [[...publisher_ids]],
  );
  for (const r of counted.rows) {
    const m = topicCounts.get(r.publisher_id) ?? new Map<string, number>();
    m.set(r.topic, Number(r.n));
    topicCounts.set(r.publisher_id, m);
  }
  const bare = await db.query<{ publisher_id: string; n: string | number }>(
    `SELECT o.publisher_id, count(*) AS n
       FROM offers o
       JOIN articles a ON a.id = o.article_id
       JOIN publishers p ON p.id = o.publisher_id
      WHERE o.publisher_id = ANY ($1::text[]) AND ${CURRENT}
        AND NOT EXISTS (SELECT 1 FROM unnest(a.topics) t WHERE trim(t) <> '')
      GROUP BY o.publisher_id`,
    [[...publisher_ids]],
  );
  for (const r of bare.rows) {
    const m = topicCounts.get(r.publisher_id) ?? new Map<string, number>();
    m.set('', Number(r.n));
    topicCounts.set(r.publisher_id, m);
  }
  const facts = await db.query<{
    offer_id: string;
    publisher_id: string;
    topics: string[];
    mime: string;
  }>(
    `SELECT o.id AS offer_id, o.publisher_id, a.topics, a.mime
       FROM offers o JOIN articles a ON a.id = o.article_id
      WHERE o.id = ANY ($1::text[]) AND o.superseded_by IS NULL
      ORDER BY o.id, o.version`,
    [[...offer_ids]],
  );
  const rows = new Map<string, CollectionRow>();
  for (const f of facts.rows)
    rows.set(f.offer_id, {
      offer_id: f.offer_id,
      publisher_id: f.publisher_id,
      topics: f.topics ?? [],
      mime: f.mime,
    });
  return { rows: [...rows.values()], topicCounts };
}
