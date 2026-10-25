// Seeds publishers, articles (with their text as content blobs), offers, authorisations and any extra
// corridors from validated data. Structure adapted from AIC_Hackathon_UnitMarket packages/core/catalogue/seed.ts
// at a36ddc03fd0b962000f686291c145b50ee337f90; content is fictional and written for SBX. Owned by SBX.
// Time comes from the injected Clock, ids from the injected Ids; running it twice adds nothing.
import {
  AccessOptionSchema,
  AffordabilitySchema,
  ArticleFactsSchema,
  CorridorSchema,
  IsoUtcSchema,
  OfferSchema,
  RightsSchema,
} from '@umsbx/contracts';
import type { Clock, Database, Ids, Offer, SqlExecutor } from '@umsbx/contracts';
import { offerIdFor } from './read';

type Rec = Record<string, unknown>;
const fail = (what: string): never => {
  throw new Error(`seed data invalid: ${what}`);
};
const rec = (v: unknown, what: string): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : fail(what);
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : fail(what));
const str = (v: unknown, what: string): string =>
  typeof v === 'string' && v.length > 0 ? v : fail(what);
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CODE = /^[A-Za-z0-9_-]{1,64}$/;

interface SeedArticle {
  key: string;
  publisher_slug: string;
  title: string;
  abstract: string;
  language: string;
  topics: string[];
  published_at: string;
  text: string;
  rights_note: string;
}
interface SeedOffer {
  code: string;
  article_key: string;
  status: Offer['status'];
  currency: string;
  options: { option: 'keep_retrieve' | 'online_read'; price_minor: number }[];
  affordability: Offer['affordability'];
  terms_version: string;
  rights: Offer['rights'];
  valid_from: string;
  valid_until: string | null;
  superseded_by: string | null;
  authorised: boolean;
}

function parse(data: unknown) {
  const d = rec(data, 'root');
  const corridors = arr(d.corridors ?? [], 'corridors').map((c) => CorridorSchema.parse(c));
  const publishers = arr(d.publishers, 'publishers').map((p) => {
    const r = rec(p, 'publisher');
    const slug = str(r.slug, 'publisher slug');
    if (!SLUG.test(slug)) fail(`publisher slug ${slug}`);
    return {
      slug,
      display_name: str(r.display_name, 'display_name'),
      country: str(r.country, 'country'),
    };
  });
  const articles: SeedArticle[] = arr(d.articles, 'articles').map((a) => {
    const r = rec(a, 'article');
    const out = {
      key: str(r.key, 'article key'),
      publisher_slug: str(r.publisher_slug, 'article publisher_slug'),
      title: str(r.title, 'title'),
      abstract: str(r.abstract, 'abstract'),
      language: str(r.language, 'language'),
      topics: arr(r.topics, 'topics').map((t) => str(t, 'topic')),
      published_at: IsoUtcSchema.parse(r.published_at),
      text: str(r.text, 'text'),
      rights_note: str(r.rights_note, 'rights_note'),
    };
    if (/https?:\/\//i.test(out.text)) fail('article text must not contain a URL');
    return out;
  });
  const offers: SeedOffer[] = arr(d.offers, 'offers').map((o) => {
    const r = rec(o, 'offer');
    const code = str(r.code, 'offer code');
    if (!CODE.test(code)) fail(`offer code ${code}`);
    return {
      code,
      article_key: str(r.article_key, 'offer article_key'),
      status: OfferSchema.shape.status.parse(r.status),
      currency: str(r.currency, 'currency'),
      options: arr(r.options, 'options').map((x) => {
        const p = rec(x, 'option');
        return {
          option: AccessOptionSchema.parse(p.option),
          price_minor: Number(p.price_minor),
        };
      }),
      affordability: AffordabilitySchema.parse(r.affordability),
      terms_version: str(r.terms_version, 'terms_version'),
      rights: RightsSchema.parse(r.rights),
      valid_from: IsoUtcSchema.parse(r.valid_from),
      valid_until: r.valid_until == null ? null : IsoUtcSchema.parse(r.valid_until),
      superseded_by: r.superseded_by == null ? null : str(r.superseded_by, 'superseded_by'),
      authorised: r.authorised === true,
    };
  });
  const slugs = new Set(publishers.map((p) => p.slug));
  const keys = new Set(articles.map((a) => a.key));
  for (const a of articles)
    if (!slugs.has(a.publisher_slug)) fail(`unknown publisher ${a.publisher_slug}`);
  for (const o of offers) if (!keys.has(o.article_key)) fail(`unknown article ${o.article_key}`);
  return { corridors, publishers, articles, offers };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function exists(tx: SqlExecutor, sql: string, params: unknown[]): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(sql, params);
  return rows[0]?.id ?? null;
}

export async function seedCatalogue(
  db: Database,
  clock: Clock,
  ids: Ids,
  data: unknown,
): Promise<{ publishers: number; articles: number; offers: number }> {
  const seed = parse(data);
  const now = clock.now().toISOString();
  const encoder = new TextEncoder();
  const hashes = new Map<string, { bytes: Uint8Array; sha: string }>();
  for (const a of seed.articles) {
    const bytes = encoder.encode(a.text);
    hashes.set(a.key, { bytes, sha: await sha256Hex(bytes) });
  }

  return db.transaction(async (tx) => {
    const counts = { publishers: 0, articles: 0, offers: 0 };
    for (const c of seed.corridors) {
      await tx.query(
        `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (id) DO NOTHING`,
        [
          c.id,
          c.currency,
          c.minor_units,
          c.buyer_countries,
          c.payee_countries,
          c.domestic_supported,
          c.min_charge_minor,
          c.enabled,
          now,
        ],
      );
    }
    const publisherId = new Map<string, string>();
    for (const p of seed.publishers) {
      let id = await exists(tx, 'SELECT id FROM publishers WHERE slug = $1', [p.slug]);
      if (!id) {
        id = ids.next('pub');
        await tx.query(
          `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,NULL,NULL,$5,$5)`,
          [id, p.slug, p.display_name, p.country, now],
        );
        counts.publishers += 1;
      }
      publisherId.set(p.slug, id);
    }
    const articleId = new Map<string, string>();
    for (const a of seed.articles) {
      const h = hashes.get(a.key)!;
      const contentKey = `seed/${a.publisher_slug}/${a.key}.txt`;
      let id = await exists(tx, 'SELECT id FROM articles WHERE content_key = $1', [contentKey]);
      if (!id) {
        id = ids.next('art');
        ArticleFactsSchema.parse({
          id,
          publisher_id: publisherId.get(a.publisher_slug),
          title: a.title,
          abstract: a.abstract,
          language: a.language,
          topics: a.topics,
          published_at: a.published_at,
          sha256: h.sha,
          content_key: contentKey,
        });
        await tx.query(
          `INSERT INTO content_blobs (content_key, sha256, mime, bytes, data, created_at, updated_at)
           VALUES ($1,$2,'text/plain',$3,$4,$5,$5)`,
          [contentKey, h.sha, h.bytes.length, h.bytes, now],
        );
        await tx.query(
          `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'text/plain',$11,$11)`,
          [
            id,
            publisherId.get(a.publisher_slug),
            a.title,
            a.abstract,
            a.language,
            a.topics,
            a.published_at,
            h.sha,
            contentKey,
            h.bytes.length,
            now,
          ],
        );
        counts.articles += 1;
      }
      articleId.set(a.key, id);
    }
    const authorOf = new Map(seed.articles.map((a) => [a.key, a.publisher_slug]));
    for (const o of seed.offers) {
      const slug = authorOf.get(o.article_key)!;
      const id = offerIdFor(slug, o.code);
      const version = '1';
      if (await exists(tx, 'SELECT id FROM offers WHERE id = $1 AND version = $2', [id, version]))
        continue;
      const offer = OfferSchema.parse({
        id,
        version,
        publisher_id: publisherId.get(slug),
        article_id: articleId.get(o.article_key),
        status: o.status,
        currency: o.currency,
        // The policy ids are the ones lane 12 migration 0001 seeds: one per access option, version 1.
        options: o.options.map((p) => ({ ...p, policy_id: p.option, policy_version: '1' })),
        affordability: o.affordability,
        terms_version: o.terms_version,
        rights: o.rights,
        valid_from: o.valid_from,
        valid_until: o.valid_until,
        superseded_by: o.superseded_by,
      });
      await tx.query(
        `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [
          offer.id,
          offer.version,
          offer.publisher_id,
          offer.article_id,
          offer.status,
          offer.currency,
          JSON.stringify(offer.options),
          JSON.stringify(offer.affordability),
          offer.terms_version,
          JSON.stringify(offer.rights),
          offer.valid_from,
          offer.valid_until,
          offer.superseded_by,
          now,
        ],
      );
      if (o.authorised) {
        await tx.query(
          `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$5,$5)`,
          [`auth_${id}_${version}`, id, version, offer.publisher_id, now],
        );
      }
      counts.offers += 1;
    }
    return counts;
  });
}

/**
 * Applies a supplementary block (for example SEED_SUPPLEMENT_COMPOSITE) after the base seed. Same
 * rules as seedCatalogue, stated for the caller: every row is looked up by slug, content key or
 * offer id first, so it can run on every boot and reaches a database that already holds the base
 * seed (the persistent disk). It takes its own Ids; an id is drawn only for a row that is new, so
 * no id of the base seed can move. It never sets a merchant id, a verification time or payee_shared.
 */
export function seedSupplement(
  db: Database,
  clock: Clock,
  ids: Ids,
  block: unknown,
): Promise<{ publishers: number; articles: number; offers: number }> {
  return seedCatalogue(db, clock, ids, block);
}
