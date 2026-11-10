// Catalogue reads: an offer with its article and publisher facts, and the authorised list.
// Adapted in shape from AIC_Hackathon_UnitMarket packages/core/catalogue/offers.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90 (offer view query). Owned by SBX.
// No price rule lives here: prices are the publisher's, stored on the offer (no universal floor).
import { ArticleFactsSchema, OfferSchema, PublisherFactsSchema } from '@umsbx/contracts';
import type {
  ArticleFacts,
  CorridorId,
  Id,
  Offer,
  PublisherFacts,
  SqlExecutor,
} from '@umsbx/contracts';
import { getCorridor } from './corridors';

export interface OfferView {
  offer: Offer;
  article: ArticleFacts;
  publisher: PublisherFacts;
}

// The offer id for a publisher's offer code. Offers have no code column in the lane 12 schema, so the
// code is part of the id (ASM-14A-1).
export const offerIdFor = (publisher_slug: string, offer_code: string): Id =>
  `ofr_${publisher_slug}_${offer_code}`;

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

const SELECT = `
  SELECT o.id AS o_id, o.version AS o_version, o.publisher_id AS o_publisher_id, o.article_id AS o_article_id,
         o.status AS o_status, o.currency AS o_currency, o.options AS o_options,
         o.affordability AS o_affordability, o.terms_version AS o_terms_version, o.rights AS o_rights,
         o.valid_from AS o_valid_from, o.valid_until AS o_valid_until, o.superseded_by AS o_superseded_by,
         a.id AS a_id, a.publisher_id AS a_publisher_id, a.title AS a_title, a.abstract AS a_abstract,
         a.language AS a_language, a.topics AS a_topics, a.published_at AS a_published_at,
         a.sha256 AS a_sha256, a.content_key AS a_content_key,
         p.id AS p_id, p.slug AS p_slug, p.display_name AS p_display_name, p.country AS p_country,
         p.paypal_merchant_id AS p_merchant, p.payee_verified_at AS p_verified_at
    FROM offers o
    JOIN articles a ON a.id = o.article_id
    JOIN publishers p ON p.id = o.publisher_id`;

type Row = Record<string, unknown>;

function toView(r: Row): OfferView {
  return {
    offer: OfferSchema.parse({
      id: r.o_id,
      version: r.o_version,
      publisher_id: r.o_publisher_id,
      article_id: r.o_article_id,
      status: r.o_status,
      currency: r.o_currency,
      options: r.o_options,
      affordability: r.o_affordability,
      terms_version: r.o_terms_version,
      rights: r.o_rights,
      valid_from: iso(r.o_valid_from),
      valid_until: isoOrNull(r.o_valid_until),
      superseded_by: r.o_superseded_by ?? null,
    }),
    article: ArticleFactsSchema.parse({
      id: r.a_id,
      publisher_id: r.a_publisher_id,
      title: r.a_title,
      abstract: r.a_abstract,
      language: r.a_language,
      topics: r.a_topics,
      published_at: iso(r.a_published_at),
      sha256: r.a_sha256,
      content_key: r.a_content_key,
    }),
    publisher: PublisherFactsSchema.parse({
      id: r.p_id,
      slug: r.p_slug,
      display_name: r.p_display_name,
      country: r.p_country,
      payee_merchant_id: r.p_merchant ?? null,
      payee_verified_at: isoOrNull(r.p_verified_at),
    }),
  };
}

// The newest version of the offer, whatever its status: the caller decides what a withdrawn or
// superseded offer means (startFromOffer reports it as a no-match, never as "unknown").
export async function getOffer(
  db: SqlExecutor,
  i: { offer_id: Id } | { publisher_slug: string; offer_code: string },
): Promise<OfferView | null> {
  // Versions are text like v9 and v10: compare the number, then the text (review 4 L6).
  const order =
    "ORDER BY o.created_at DESC, NULLIF(regexp_replace(o.version, '[^0-9]', '', 'g'), '')::numeric DESC NULLS LAST, o.version DESC LIMIT 1";
  const { rows } =
    'offer_id' in i
      ? await db.query<Row>(`${SELECT} WHERE o.id = $1 ${order}`, [i.offer_id])
      : await db.query<Row>(`${SELECT} WHERE p.slug = $1 AND o.id = $2 ${order}`, [
          i.publisher_slug,
          offerIdFor(i.publisher_slug, i.offer_code),
        ]);
  return rows[0] ? toView(rows[0]) : null;
}

// Authorised, current (not superseded, newest version) offers of an active publisher whose currency
// and payee country fit an enabled corridor. Validity dates are not filtered here (no clock in this signature); startFromOffer
// checks them on every quote (ASM-14A-4).
export async function listAuthorisedOffers(
  db: SqlExecutor,
  i: { corridor_id: CorridorId; limit: number },
): Promise<OfferView[]> {
  const corridor = await getCorridor(db, i.corridor_id);
  if (!corridor || !corridor.enabled) return [];
  const limit = Math.max(1, Math.min(500, Math.trunc(i.limit) || 1));
  const { rows } = await db.query<Row>(
    `${SELECT}
      WHERE o.status = 'authorised' AND o.superseded_by IS NULL AND p.status = 'active'
        AND o.currency = $1 AND p.country = ANY ($2)
        AND EXISTS (SELECT 1 FROM publisher_authorisations pa WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
        AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND (n.created_at, n.version) > (o.created_at, o.version))
      ORDER BY o.id, o.version
      LIMIT $3`,
    [corridor.currency, corridor.payee_countries, limit],
  );
  return rows.map(toView);
}

// CAT-1.1: the authorised offers of a corridor that match the buyer's words, fair across publishers.
// Every guard of listAuthorisedOffers runs first (inside the CTE), with the score > 0 filter; only then does
// ROW_NUMBER cap each publisher at per_publisher, so an excluded row never uses a slot. A word hits a text
// when the whole word matches case-insensitively (like searchOffers: "art" does not match "start"). The words
// reach SQL as one bound text[] and each is only letters and digits, so no regex metacharacter gets through.
// Case folding is guaranteed for ASCII only (PGlite and Postgres decide the rest by locale).
// CAT-2.2: exact copies (same publisher, same sha256) collapse to the smallest offer id inside the guarded CTE,
// before ROW_NUMBER, so ten copies of a photo use one slot; duplicates_hidden counts the publisher's other copies.
const WORD_PATTERN = /^[\p{L}\p{N}]{3,40}$/u;
const MAX_WORDS = 12;

export async function listAuthorisedOffersMatching(
  db: SqlExecutor,
  i: { corridor_id: CorridorId; words: readonly string[]; per_publisher: number; limit: number },
): Promise<{ view: OfferView; score: number; duplicates_hidden: number }[]> {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const w of i.words) {
    if (typeof w !== 'string' || !WORD_PATTERN.test(w)) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(w);
    if (words.length === MAX_WORDS) break;
  }
  if (words.length === 0) return [];
  const corridor = await getCorridor(db, i.corridor_id);
  if (!corridor || !corridor.enabled) return [];
  const perPublisher = Math.max(1, Math.min(50, Math.trunc(i.per_publisher) || 1));
  const limit = Math.max(1, Math.min(500, Math.trunc(i.limit) || 1));
  const { rows } = await db.query<Row>(
    `WITH matched AS (
       SELECT DISTINCT ON (o.publisher_id, a.sha256)
              o.id AS m_id, o.version AS m_version, o.publisher_id AS m_publisher, s.score AS m_score,
              (SELECT count(*) FROM offers d
                 JOIN articles da ON da.id = d.article_id
                 JOIN publishers dp ON dp.id = d.publisher_id
                WHERE d.publisher_id = o.publisher_id AND da.sha256 = a.sha256 AND d.id <> o.id
                  AND d.status = 'authorised' AND d.superseded_by IS NULL AND dp.status = 'active'
                  AND EXISTS (SELECT 1 FROM publisher_authorisations pa WHERE pa.offer_id = d.id AND pa.offer_version = d.version)
                  AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = d.id AND (n.created_at, n.version) > (d.created_at, d.version))
              )::int AS m_dups
         FROM offers o
         JOIN articles a ON a.id = o.article_id
         JOIN publishers p ON p.id = o.publisher_id
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(CASE
                    WHEN a.title ~* ('\\m' || w || '\\M')
                      OR EXISTS (SELECT 1 FROM unnest(a.topics) t WHERE t ~* ('\\m' || w || '\\M')) THEN 2
                    WHEN a.abstract ~* ('\\m' || w || '\\M') THEN 1
                    ELSE 0 END), 0)::int AS score
             FROM unnest($3::text[]) AS w
         ) s
        WHERE o.status = 'authorised' AND o.superseded_by IS NULL AND p.status = 'active'
          AND o.currency = $1 AND p.country = ANY ($2)
          AND EXISTS (SELECT 1 FROM publisher_authorisations pa WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
          AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND (n.created_at, n.version) > (o.created_at, o.version))
          AND s.score > 0
        ORDER BY o.publisher_id, a.sha256, o.id
     ), capped AS (
       SELECT m_id, m_version, m_score, m_dups,
              ROW_NUMBER() OVER (PARTITION BY m_publisher ORDER BY m_score DESC, m_id) AS rn
         FROM matched
     )
     SELECT v.*, c.m_score AS score, c.m_dups AS dups
       FROM (${SELECT}) v
       JOIN capped c ON c.m_id = v.o_id AND c.m_version = v.o_version
      WHERE c.rn <= $4
      ORDER BY c.m_score DESC, v.o_id
      LIMIT $5`,
    [corridor.currency, corridor.payee_countries, words, perPublisher, limit],
  );
  return rows.map((r) => ({
    view: toView(r),
    score: Number(r.score),
    duplicates_hidden: Number(r.dups),
  }));
}
