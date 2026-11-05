// FEED (E-03), reused by the web import (POB-I1, D-089). A strict reader for feeds (JSON, Atom, RSS) and the
// sanitiser every text from a site goes through. Pure: no network, no clock, no database, no dependency.
//
// What the text becomes: plain data. Tags are removed (script and style bodies with them), character
// references are decoded once and the result is stripped again, control and invisible characters go, and no
// angle bracket survives. Nothing here is ever HTML, a link to follow, or an instruction. The XML reader
// refuses DOCTYPE, ENTITY and processing instructions outright (no entity can expand, no file can be
// named), caps depth and element count, and never recurses. Every loop is linear in its input.
import { err, ok } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';

export const FEED_MAX_ITEMS = 100;
export const FEED_TITLE_MAX = 200;
export const FEED_ABSTRACT_MAX = 600;
export const FEED_BODY_MAX = 20_000;
export const FEED_SOURCE_ID_MAX = 200;
export const FEED_TOPICS_MAX = 8;
export const FEED_TOPIC_MAX = 40;
const XML_MAX_DEPTH = 32;
const XML_MAX_ELEMENTS = 20_000;

export interface FeedItem {
  source_id: string;
  title: string;
  abstract: string;
  body: string;
  language: string;
  topics: string[];
  /** ISO time or null; the importer clamps it to now. */
  published_at: string | null;
  /** The feed's proposed price when it is a safe integer, else null. Range is the importer's rule. */
  price_minor: number | null;
  /** The entry's own page: plain http or https text of at most 2048 visible characters, else null. Never fetched here. */
  link: string | null;
}

export interface ParseOptions {
  /**
   * Keep an entry that has a link but no text (the web import reads its own page later). Such an entry has an
   * empty body, takes its summary from the title and, with no id, its link as the id. Default false: an entry
   * without text is skipped, as FEED had it.
   */
  keepBodyless?: boolean;
}

export type FeedParseCode = 'bad_json' | 'bad_xml' | 'unsupported' | 'too_many_items';
export interface FeedParseError {
  code: FeedParseCode;
}
export interface ParsedFeed {
  items: FeedItem[];
  /** Entries that could not be used (no id, no title, no text, too long, a repeat, not an object). */
  skipped: number;
}

// ---------------------------------------------------------------------------------------------
// Text

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const ENTITY = /&(?:#([0-9]{1,8})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g;

function decodeOnce(s: string): string {
  return s.replace(ENTITY, (m, dec: string | undefined, hex: string | undefined, name?: string) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
    if (!Number.isInteger(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
      return '';
    return String.fromCodePoint(cp);
  });
}

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * Removes comments, script and style elements with their contents, and every other tag. A '<' that does not
 * start a tag is dropped. One left to right pass: after the first search that finds no '>' the rest cannot
 * hold a tag, so hostile input is linear.
 */
function stripMarkup(s: string): string {
  const n = s.length;
  let out = '';
  let i = 0;
  let noGt = false;
  const closers: Record<string, RegExp> = {
    script: /<\/script/gi,
    style: /<\/style/gi,
  };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e === -1) break;
      i = e + 3;
      continue;
    }
    const c = lt + 1 < n ? s.charCodeAt(lt + 1) : 0;
    if (!(isLetter(c) || c === 47 /* / */ || c === 33 /* ! */ || c === 63) /* ? */) {
      i = lt + 1; // a stray '<' is dropped
      continue;
    }
    if (isLetter(c)) {
      let k = lt + 1;
      while (
        k < n &&
        (isLetter(s.charCodeAt(k)) || (s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57))
      )
        k += 1;
      const name = s.slice(lt + 1, k).toLowerCase();
      const closer = closers[name];
      if (closer !== undefined) {
        closer.lastIndex = k;
        const m = closer.exec(s);
        if (m === null) break; // no end tag: the rest is script text
        const gt = s.indexOf('>', m.index);
        if (gt === -1) break;
        i = gt + 1;
        continue;
      }
    }
    const gt = noGt ? -1 : s.indexOf('>', lt + 1);
    if (gt === -1) {
      noGt = true;
      i = lt + 1;
      continue;
    }
    i = gt + 1;
  }
  return out;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

export interface SanitiseOptions {
  /** At most this many characters (code points) are kept. */
  max: number;
  /** Keep line breaks (one blank line at most). Default: one line. */
  multiline?: boolean;
}

/** Feed text to plain data. Total: never throws, always returns a string without '<' or '>'. */
export function sanitiseFeedText(raw: unknown, o: SanitiseOptions): string {
  if (typeof raw !== 'string') return '';
  let s = stripMarkup(raw);
  s = stripMarkup(decodeOnce(s));
  s = s.replace(/[<>]/g, '');
  s = s.replace(/\r\n?/g, '\n').replace(INVISIBLE, (m) => (m === '\n' || m === '\t' ? m : ''));
  if (o.multiline === true) {
    s = s
      .split('\n')
      .map((l) => l.replace(/[^\S\n]+/gu, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    s = s.replace(/\s+/gu, ' ').trim();
  }
  if (o.max <= 0) return '';
  return s.length <= o.max ? s : Array.from(s).slice(0, o.max).join('');
}

// ---------------------------------------------------------------------------------------------
// Items

interface RawItem {
  id: unknown;
  title: unknown;
  summary: unknown;
  body: unknown;
  language: unknown;
  topics: unknown;
  published: unknown;
  price: unknown;
  link?: unknown;
}

const cpLength = (s: string): number => Array.from(s).length;

function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? iso : null;
}

const LINK_SHAPE = /^https?:\/\/[\x21-\x7e]+$/;
function cleanLink(v: unknown): string | null {
  const t = sanitiseFeedText(v, { max: 2049 });
  return t.length > 0 && t.length <= 2048 && LINK_SHAPE.test(t) ? t : null;
}

function buildItem(r: RawItem, keepBodyless: boolean): FeedItem | null {
  const link = cleanLink(r.link);
  let source_id = sanitiseFeedText(r.id, { max: FEED_SOURCE_ID_MAX });
  if (source_id === '' && keepBodyless && link !== null)
    source_id = link.slice(0, FEED_SOURCE_ID_MAX);
  const title = sanitiseFeedText(r.title, { max: FEED_TITLE_MAX });
  if (source_id === '' || title === '') return null;
  const body = sanitiseFeedText(r.body, { max: FEED_BODY_MAX + 1, multiline: true });
  if (body === '' && !(keepBodyless && link !== null)) return null;
  if (cpLength(body) > FEED_BODY_MAX) return null;
  let abstract = sanitiseFeedText(r.summary, { max: FEED_ABSTRACT_MAX });
  if (abstract === '') abstract = sanitiseFeedText(body, { max: FEED_ABSTRACT_MAX });
  if (abstract === '' && keepBodyless) abstract = title;
  if (abstract === '') return null;
  const lang = sanitiseFeedText(r.language, { max: 16 }).toLowerCase();
  const language = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang) ? lang : 'und';
  const topics: string[] = [];
  if (Array.isArray(r.topics)) {
    for (const t of r.topics as unknown[]) {
      if (topics.length >= FEED_TOPICS_MAX) break;
      const clean = sanitiseFeedText(t, { max: FEED_TOPIC_MAX });
      if (clean !== '') topics.push(clean);
    }
  }
  const price_minor = typeof r.price === 'number' && Number.isSafeInteger(r.price) ? r.price : null;
  return {
    source_id,
    title,
    abstract,
    body,
    language,
    topics,
    published_at: toIso(r.published),
    price_minor,
    link,
  };
}

function collect(
  raws: Iterable<RawItem | null>,
  keepBodyless: boolean,
): Result<ParsedFeed, FeedParseError> {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of raws) {
    const item = r === null ? null : buildItem(r, keepBodyless);
    if (item === null || seen.has(item.source_id)) {
      skipped += 1;
      continue;
    }
    seen.add(item.source_id);
    items.push(item);
  }
  return ok({ items, skipped });
}

// ---------------------------------------------------------------------------------------------
// JSON

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const first = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (Object.hasOwn(o, k) && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function parseJson(text: string, keepBodyless: boolean): Result<ParsedFeed, FeedParseError> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return err({ code: 'bad_json' });
  }
  if (!isObject(doc) || !Object.hasOwn(doc, 'items') || !Array.isArray(doc['items']))
    return err({ code: 'unsupported' });
  const list = doc['items'] as unknown[];
  if (list.length > FEED_MAX_ITEMS) return err({ code: 'too_many_items' });
  return collect(
    list.map((v): RawItem | null =>
      isObject(v)
        ? {
            id: first(v, ['id']),
            title: first(v, ['title']),
            summary: first(v, ['summary', 'abstract']),
            body: first(v, ['content_text', 'content_html', 'content', 'body']),
            language: first(v, ['language']),
            topics: first(v, ['topics', 'tags']),
            published: first(v, ['published', 'date_published']),
            price: first(v, ['price_minor']),
            link: first(v, ['url']),
          }
        : null,
    ),
    keepBodyless,
  );
}

// ---------------------------------------------------------------------------------------------
// XML (Atom and RSS)

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Direct text and CDATA, in order, character references NOT decoded (the sanitiser decodes once). */
  text: string;
}

const ATTR = /[ \t\r\n]+([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /[ \t\r\n]*(\/?)>/y;
const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const XML_DECL = /^<\?xml[ \t\r\n][^>]*\?>/;

export function readXml(input: string): XNode | null {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let pos = 0;
  const decl = XML_DECL.exec(s);
  if (decl !== null) pos = decl[0].length;
  const n = s.length;
  const stack: XNode[] = [];
  let root: XNode | null = null;
  let elements = 0;
  while (pos < n) {
    const lt = s.indexOf('<', pos);
    const text = s.slice(pos, lt === -1 ? n : lt);
    if (text !== '') {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.text += text;
      else if (text.trim() !== '') return null; // text outside the root
    }
    if (lt === -1) break;
    pos = lt;
    if (s.startsWith('<!--', pos)) {
      const e = s.indexOf('-->', pos + 4);
      if (e === -1) return null;
      pos = e + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', pos)) {
      const top = stack[stack.length - 1];
      const e = s.indexOf(']]>', pos + 9);
      if (top === undefined || e === -1) return null;
      top.text += s.slice(pos + 9, e);
      pos = e + 3;
      continue;
    }
    if (s.startsWith('<!', pos) || s.startsWith('<?', pos)) return null; // DOCTYPE, ENTITY, instructions
    if (s.startsWith('</', pos)) {
      NAME.lastIndex = pos + 2;
      const m = NAME.exec(s);
      const top = stack[stack.length - 1];
      if (m === null || top === undefined || m[0] !== top.name) return null;
      TAG_END.lastIndex = NAME.lastIndex;
      const end = TAG_END.exec(s);
      if (end === null || end[1] !== '') return null;
      pos = TAG_END.lastIndex;
      stack.pop();
      continue;
    }
    NAME.lastIndex = pos + 1;
    const nm = NAME.exec(s);
    if (nm === null) return null;
    elements += 1;
    if (elements > XML_MAX_ELEMENTS) return null;
    const node: XNode = { name: nm[0], attrs: {}, children: [], text: '' };
    let at = NAME.lastIndex;
    for (;;) {
      ATTR.lastIndex = at;
      const a = ATTR.exec(s);
      if (a === null) break;
      const key = a[1] as string;
      if (Object.hasOwn(node.attrs, key)) return null;
      node.attrs[key] = a[2] ?? a[3] ?? '';
      at = ATTR.lastIndex;
    }
    TAG_END.lastIndex = at;
    const end = TAG_END.exec(s);
    if (end === null) return null;
    pos = TAG_END.lastIndex;
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== null) return null; // a second root
      root = node;
    } else {
      parent.children.push(node);
    }
    if (end[1] === '') {
      if (stack.length + 1 > XML_MAX_DEPTH) return null;
      stack.push(node);
    }
  }
  return stack.length === 0 ? root : null;
}

const child = (n: XNode, name: string): XNode | undefined =>
  n.children.find((c) => c.name === name);
const textOf = (n: XNode | undefined): string | undefined => n?.text;

function parseXml(text: string, keepBodyless: boolean): Result<ParsedFeed, FeedParseError> {
  const root = readXml(text);
  if (root === null) return err({ code: 'bad_xml' });
  let raws: RawItem[];
  if (root.name === 'feed') {
    const entries = root.children.filter((c) => c.name === 'entry');
    if (entries.length > FEED_MAX_ITEMS) return err({ code: 'too_many_items' });
    raws = entries.map((e) => ({
      id: textOf(child(e, 'id')),
      title: textOf(child(e, 'title')),
      summary: textOf(child(e, 'summary')),
      body: textOf(child(e, 'content')),
      language: e.attrs['xml:lang'] ?? root.attrs['xml:lang'],
      topics: e.children.filter((c) => c.name === 'category').map((c) => c.attrs['term']),
      published: textOf(child(e, 'published')) ?? textOf(child(e, 'updated')),
      price: undefined,
      link: e.children.find(
        (c) => c.name === 'link' && (c.attrs['rel'] ?? 'alternate') === 'alternate',
      )?.attrs['href'],
    }));
  } else if (root.name === 'rss') {
    const channel = child(root, 'channel');
    if (channel === undefined) return err({ code: 'unsupported' });
    const items = channel.children.filter((c) => c.name === 'item');
    if (items.length > FEED_MAX_ITEMS) return err({ code: 'too_many_items' });
    raws = items.map((it) => ({
      id: textOf(child(it, 'guid')),
      title: textOf(child(it, 'title')),
      summary: textOf(child(it, 'description')),
      body: textOf(child(it, 'content:encoded')) ?? textOf(child(it, 'description')),
      language: textOf(child(channel, 'language')),
      topics: it.children.filter((c) => c.name === 'category').map((c) => c.text),
      published: textOf(child(it, 'pubDate')),
      price: undefined,
      link: textOf(child(it, 'link')),
    }));
  } else {
    return err({ code: 'unsupported' });
  }
  return collect(raws, keepBodyless);
}

// ---------------------------------------------------------------------------------------------

const JSON_TYPES = new Set(['application/json', 'application/feed+json']);
const XML_TYPES = new Set([
  'application/atom+xml',
  'application/rss+xml',
  'application/xml',
  'text/xml',
]);

/** Reads a feed body. `contentType` is the media type the fetcher saw (parameters are ignored). */
export function parseFeed(
  body: string,
  contentType: string,
  opts: ParseOptions = {},
): Result<ParsedFeed, FeedParseError> {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const keep = opts.keepBodyless === true;
  if (JSON_TYPES.has(type)) return parseJson(body, keep);
  if (XML_TYPES.has(type)) return parseXml(body, keep);
  return err({ code: 'unsupported' });
}
