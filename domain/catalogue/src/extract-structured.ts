// POB-I1 (D-089, A1): the deterministic reader of a publisher's page or feed. Structured data only, written by
// hand, no model, no dependency: schema.org JSON-LD (Product, Article and its kin, ItemList), OpenGraph, RSS,
// Atom, JSON feed and a sitemap. A page with none of it gives no items and a plain reason.
//
// Pure: no network, no database, no clock. It never fetches; it only reports addresses (an item's own page
// and its picture) for the importer to ask for through the guarded fetcher, and drops every address that is
// not https. Every text goes through sanitiseFeedText (no tag, no script, no control character, no angle
// bracket). Limits: 20 JSON-LD blocks of 256 KB, 8 levels of nesting, 100 items, the field caps of the feed
// reader. Hostile input costs time in proportion to its length.
import { scanHtml } from './html-scan';
import { parseFeed, readXml, sanitiseFeedText } from './feed-parse';
import type { XNode } from './feed-parse';

export const EXTRACT_MAX_ITEMS = 100;
const MAX_DEPTH = 8;
const KEY_MAX = 500;
const TITLE_MAX = 200;
const SUMMARY_MAX = 600;
const BODY_MAX = 20_000;
const TOPIC_MAX = 40;
const TOPICS_MAX = 8;
const URL_MAX = 500;

export interface Candidate {
  kind: 'article' | 'image';
  /** Stable key of the item at the source: its id, its address, or `name:` and its title. At most 500 characters. */
  source_key: string;
  title: string;
  summary: string;
  /** A language tag or `und`. */
  language: string;
  topics: string[];
  published_at: string | null;
  /** The text of an article, or null (the item's own page may supply it). */
  body: string | null;
  /** The address of the picture as found: https only, not yet fetched, not yet checked against the host. */
  image_url: string | null;
  /** The item's own page: https on the same host as the source, else null. */
  page_url: string | null;
  /** The source's price proposal in minor units (whole, 1 or more) and the currency it named, if any. */
  price_minor: number | null;
  price_currency: string | null;
}

export type ExtractReason =
  'no_structured_data' | 'unsupported_type' | 'bad_document' | 'too_many_items' | 'sitemap_index';

export interface Extracted {
  candidates: Candidate[];
  /** Same host pages to read one by one (a sitemap, an item list). */
  links: string[];
  /** Entries that could not be used (no title, too long, a repeat, an address off the host, a broken block). */
  skipped: number;
  /** Why there is nothing, when there is nothing. */
  reason: ExtractReason | null;
}

const none = (reason: ExtractReason, skipped = 0): Extracted => ({
  candidates: [],
  links: [],
  skipped,
  reason,
});

// ---------------------------------------------------------------------------------------------
// Small helpers

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => sanitiseFeedText(v, { max });
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** https only, no user, no odd port, at most 500 characters, no fragment. Dot segments are resolved. */
function cleanHttps(v: unknown): URL | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0 || t.length > URL_MAX || !/^[\x21-\x7e]+$/.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '')
    return null;
  u.hash = '';
  return u.href.length <= URL_MAX ? u : null;
}
const onHost = (u: URL | null, host: string): string | null =>
  u !== null && u.hostname === host ? u.href : null;

/** A decimal price with at most two decimals, to minor units. 1 or more, else null. */
function toMinor(v: unknown): number | null {
  const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t);
  if (m === null) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return minor >= 1 && Number.isSafeInteger(minor) ? minor : null;
}
const currencyOf = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : null;
};

function langOf(v: unknown): string {
  const t = text(typeof v === 'string' ? v.replace(/_/g, '-') : '', 16).toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(t) ? t : 'und';
}

function topicsOf(v: unknown): string[] {
  const list: unknown[] = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',').slice(0, TOPICS_MAX * 4)
      : [];
  const out: string[] = [];
  for (const t of list) {
    if (out.length >= TOPICS_MAX) break;
    const clean = text(t, TOPIC_MAX);
    if (clean !== '') out.push(clean);
  }
  return out;
}

function dateOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? iso : null;
}

const cpLen = (s: string): number => Array.from(s).length;

// ---------------------------------------------------------------------------------------------
// JSON-LD

const ARTICLE_TYPES = new Set([
  'Article',
  'NewsArticle',
  'BlogPosting',
  'TechArticle',
  'ScholarlyArticle',
]);
const IMAGE_TYPES = new Set(['Product', 'ImageObject', 'Photograph']);

function typeOf(node: Record<string, unknown>): 'article' | 'image' | 'list' | null {
  const raw = node['@type'];
  const types = (Array.isArray(raw) ? raw : [raw]).filter(
    (t): t is string => typeof t === 'string',
  );
  if (types.some((t) => ARTICLE_TYPES.has(t))) return 'article';
  if (types.some((t) => IMAGE_TYPES.has(t))) return 'image';
  if (types.includes('ItemList')) return 'list';
  return null;
}

function imageOf(v: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (Array.isArray(v)) {
    // The first entry that holds a usable address.
    for (const e of v.slice(0, 8)) {
      const u = imageOf(e, depth + 1);
      if (u !== null) return u;
    }
    return null;
  }
  if (isObject(v)) return imageOf(v['contentUrl'] ?? v['url'], depth + 1);
  const u = cleanHttps(v);
  return u === null ? null : u.href;
}

function offerOf(v: unknown): { price_minor: number | null; price_currency: string | null } {
  // A list of offers: the first entry. An aggregate offer: its low price.
  const o = first(v);
  if (!isObject(o)) return { price_minor: null, price_currency: null };
  return {
    price_minor: toMinor(o['price'] ?? o['lowPrice']),
    price_currency: currencyOf(o['priceCurrency']),
  };
}

interface Collected {
  candidates: Candidate[];
  links: string[];
  skipped: number;
}

function fromNode(
  node: Record<string, unknown>,
  kind: 'article' | 'image',
  host: string,
  out: Collected,
): void {
  const title = text(node['headline'] ?? node['name'], TITLE_MAX);
  if (title === '') {
    out.skipped += 1;
    return;
  }
  const idText = node['@id'];
  const urlRaw = node['url'];
  const key =
    text(typeof idText === 'string' ? idText : urlRaw, KEY_MAX) ||
    `name:${title}`.slice(0, KEY_MAX);
  // An explicit `url` that is not on this host is not replaced by the @id: it is dropped.
  const page_url = onHost(cleanHttps(urlRaw !== undefined ? urlRaw : idText), host);
  let body: string | null = null;
  if (kind === 'article') {
    const raw = node['articleBody'] ?? node['text'] ?? node['description'];
    const b = sanitiseFeedText(raw, { max: BODY_MAX + 1, multiline: true });
    if (cpLen(b) > BODY_MAX) {
      out.skipped += 1;
      return;
    }
    body = b === '' ? null : b;
  }
  let summary = text(node['description'], SUMMARY_MAX);
  if (summary === '' && body !== null) summary = text(body, SUMMARY_MAX);
  if (summary === '') summary = title;
  const offer = offerOf(node['offers']);
  out.candidates.push({
    kind,
    source_key: key,
    title,
    summary,
    language: langOf(node['inLanguage']),
    topics: topicsOf(node['keywords']),
    published_at: dateOf(node['datePublished'] ?? node['dateCreated']),
    body,
    image_url: kind === 'image' ? imageOf(node['image'] ?? node['contentUrl']) : null,
    page_url,
    price_minor: offer.price_minor,
    price_currency: offer.price_currency,
  });
}

function addLink(v: unknown, host: string, out: Collected): void {
  const href = onHost(cleanHttps(v), host);
  if (href === null) out.skipped += 1;
  else if (!out.links.includes(href)) out.links.push(href);
}

/** Walks one parsed JSON-LD value, breadth first through an explicit stack, to a depth of 8. */
function walkJsonLd(root: unknown, host: string, out: Collected): void {
  const stack: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  // Document order: process the stack as a queue.
  let head = 0;
  while (head < stack.length) {
    const { v, d } = stack[head++]!;
    if (head > 4000) return;
    if (Array.isArray(v)) {
      if (d >= MAX_DEPTH) continue;
      for (const e of v.slice(0, EXTRACT_MAX_ITEMS + 2)) stack.push({ v: e, d: d + 1 });
      continue;
    }
    if (!isObject(v)) continue;
    const t = typeOf(v);
    if (t === 'article' || t === 'image') {
      fromNode(v, t, host, out);
      continue;
    }
    if (t === 'list') {
      if (d >= MAX_DEPTH) continue;
      const elements = v['itemListElement'];
      const list = (Array.isArray(elements) ? elements : [elements]).slice(
        0,
        EXTRACT_MAX_ITEMS + 2,
      );
      for (const el of list) {
        if (!isObject(el)) {
          if (typeof el === 'string') addLink(el, host, out);
          continue;
        }
        const inner = el['item'];
        if (typeOf(el) === 'article' || typeOf(el) === 'image') stack.push({ v: el, d: d + 1 });
        else if (isObject(inner)) {
          if (typeOf(inner) !== null) stack.push({ v: inner, d: d + 1 });
          else if (inner['url'] !== undefined || inner['@id'] !== undefined)
            addLink(inner['url'] ?? inner['@id'], host, out);
        } else if (typeof inner === 'string') addLink(inner, host, out);
        else if (el['url'] !== undefined) addLink(el['url'], host, out);
      }
      continue;
    }
    // A container: @graph, or a wrapper such as a WebPage that holds the entities.
    if (d >= MAX_DEPTH) continue;
    const graph = v['@graph'];
    if (graph !== undefined) stack.push({ v: graph, d: d + 1 });
    for (const k of ['mainEntity', 'about']) if (isObject(v[k])) stack.push({ v: v[k], d: d + 1 });
  }
}

function fromJsonLdBlocks(blocks: string[], oversize: number, host: string): Collected {
  const out: Collected = { candidates: [], links: [], skipped: oversize };
  for (const b of blocks) {
    let v: unknown;
    try {
      v = JSON.parse(b);
    } catch {
      out.skipped += 1;
      continue;
    }
    walkJsonLd(v, host, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// OpenGraph

function fromOpenGraph(metas: Record<string, string>[], host: string): Candidate | null {
  const og = new Map<string, string>();
  const tags: string[] = [];
  for (const m of metas) {
    const p = m['property']?.toLowerCase();
    const c = m['content'];
    if (p === undefined || c === undefined) continue;
    if (p === 'article:tag') tags.push(c);
    else if (!og.has(p)) og.set(p, c);
  }
  const title = text(og.get('og:title'), TITLE_MAX);
  if (title === '') return null;
  const type = (og.get('og:type') ?? '').toLowerCase();
  const image = imageOf(og.get('og:image'));
  const desc = sanitiseFeedText(og.get('og:description'), { max: BODY_MAX, multiline: true });
  let kind: 'article' | 'image';
  if (type === 'article') kind = 'article';
  else if (image !== null) kind = 'image';
  else return null;
  const url = og.get('og:url');
  const key = text(url, KEY_MAX) || `name:${title}`.slice(0, KEY_MAX);
  const summary = text(desc, SUMMARY_MAX) || title;
  const amount = og.get('product:price:amount') ?? og.get('og:price:amount');
  const currency = og.get('product:price:currency') ?? og.get('og:price:currency');
  return {
    kind,
    source_key: key,
    title,
    summary,
    language: langOf(og.get('og:locale')),
    topics: topicsOf(tags),
    published_at: dateOf(og.get('article:published_time')),
    body: kind === 'article' && desc !== '' ? desc : null,
    image_url: kind === 'image' ? image : null,
    page_url: onHost(cleanHttps(url), host),
    price_minor: toMinor(amount),
    price_currency: currencyOf(currency),
  };
}

// ---------------------------------------------------------------------------------------------
// Feeds and sitemaps

function fromFeed(body: string, contentType: string, host: string): Extracted {
  const parsed = parseFeed(body, contentType, { keepBodyless: true });
  if (!parsed.ok) {
    const code = parsed.error.code;
    return none(
      code === 'too_many_items'
        ? 'too_many_items'
        : code === 'unsupported'
          ? 'unsupported_type'
          : 'bad_document',
    );
  }
  const candidates: Candidate[] = parsed.value.items.map((i) => ({
    kind: 'article' as const,
    source_key: i.source_id,
    title: i.title,
    summary: i.abstract,
    language: i.language,
    topics: i.topics,
    published_at: i.published_at,
    body: i.body === '' ? null : i.body,
    image_url: null,
    page_url: i.link === null ? null : onHost(cleanHttps(i.link), host),
    price_minor: i.price_minor !== null && i.price_minor >= 1 ? i.price_minor : null,
    price_currency: null,
  }));
  if (candidates.length === 0) return none('no_structured_data', parsed.value.skipped);
  return { candidates, links: [], skipped: parsed.value.skipped, reason: null };
}

const childNamed = (n: XNode, name: string): XNode | undefined =>
  n.children.find((c) => c.name === name);

function fromSitemap(root: XNode, host: string): Extracted {
  const out: Collected = { candidates: [], links: [], skipped: 0 };
  for (const u of root.children) {
    if (u.name !== 'url') continue;
    const loc = childNamed(u, 'loc');
    if (loc === undefined) {
      out.skipped += 1;
      continue;
    }
    addLink(sanitiseFeedText(loc.text, { max: URL_MAX + 1 }), host, out);
    if (out.links.length > EXTRACT_MAX_ITEMS) return none('too_many_items');
  }
  if (out.links.length === 0) return none('no_structured_data', out.skipped);
  return { candidates: [], links: out.links, skipped: out.skipped, reason: null };
}

function fromXml(body: string, contentType: string, host: string): Extracted {
  const root = readXml(body);
  if (root === null) return none('bad_document');
  if (root.name === 'sitemapindex') return none('sitemap_index');
  if (root.name === 'urlset') return fromSitemap(root, host);
  return fromFeed(body, contentType, host);
}

// ---------------------------------------------------------------------------------------------

function finish(c: Collected): Extracted {
  const total = c.candidates.length + c.links.length;
  if (total > EXTRACT_MAX_ITEMS) return none('too_many_items', c.skipped);
  // A key used twice on one page is one item.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let skipped = c.skipped;
  for (const cand of c.candidates) {
    if (seen.has(cand.source_key)) {
      skipped += 1;
      continue;
    }
    seen.add(cand.source_key);
    candidates.push(cand);
  }
  if (candidates.length === 0 && c.links.length === 0) return none('no_structured_data', skipped);
  return { candidates, links: c.links, skipped, reason: null };
}

function fromHtml(html: string, host: string): Extracted {
  const scan = scanHtml(html, { head_only: false, ld: true });
  // OpenGraph is read from the head only; the scan collects meta tags only while the head lasts.
  const collected = fromJsonLdBlocks(scan.ld, scan.ld_oversize, host);
  if (collected.candidates.length === 0 && collected.links.length === 0) {
    const og = fromOpenGraph(scan.metas, host);
    if (og !== null) collected.candidates.push(og);
  }
  return finish(collected);
}

/**
 * Reads one body. `contentType` is the media type the fetcher saw (parameters are ignored); `host` is the
 * verified host: addresses off it are dropped (and counted as skipped), never kept.
 */
export function extractSource(body: string, contentType: string, host: string): Extracted {
  if (typeof body !== 'string') return none('bad_document');
  const type = (typeof contentType === 'string' ? (contentType.split(';')[0] ?? '') : '')
    .trim()
    .toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return fromHtml(body, host);
  if (type === 'application/ld+json') {
    let v: unknown;
    try {
      v = JSON.parse(body);
    } catch {
      return none('bad_document');
    }
    const out: Collected = { candidates: [], links: [], skipped: 0 };
    walkJsonLd(v, host, out);
    return finish(out);
  }
  if (type === 'application/json' || type === 'application/feed+json') {
    let v: unknown;
    try {
      v = JSON.parse(body);
    } catch {
      return none('bad_document');
    }
    if (isObject(v) && Array.isArray(v['items'])) return fromFeed(body, type, host);
    if (isObject(v) && ('@context' in v || '@graph' in v || '@type' in v)) {
      const out: Collected = { candidates: [], links: [], skipped: 0 };
      walkJsonLd(v, host, out);
      return finish(out);
    }
    return none('unsupported_type');
  }
  if (
    type === 'application/xml' ||
    type === 'text/xml' ||
    type === 'application/rss+xml' ||
    type === 'application/atom+xml'
  )
    return fromXml(body, type, host);
  return none('unsupported_type');
}
