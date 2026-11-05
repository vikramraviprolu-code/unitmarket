// POB-I1 (D-089): one small, strict, linear HTML tag scanner for the two readers that must not be fooled by
// hostile pages: the proof of a domain (domain-proof.ts) and the structured data reader (extract-structured.ts).
// It is not an HTML parser. It reads a page left to right ONCE, tells live tags from text that only looks like
// a tag, and gives back the meta tags of the head and the JSON-LD script blocks. Pure: no network, no clock,
// no dependency, no recursion.
//
// What is NOT live (never read as a tag): the inside of a comment, of script, style, title and textarea
// (raw text up to their end tag), and of noscript and template (counted in depth, so a nested one does not
// end the skip early). A stray end tag of the wrong kind does not close anything. Whatever never closes (a
// comment, a script, a tag with no end, a skip element) ends the scan: nothing after it is read. The head is
// over at </head>, at the first element that does not belong in a head, and at the first text that is not
// white space; meta tags after that are not collected. Each step moves forward and no text is searched
// twice, so hostile input costs time in proportion to its length.

export interface HtmlScan {
  /** Meta tags of the head, in order: attribute names lower case, first attribute of a name wins. At most 500. */
  metas: Record<string, string>[];
  /** Text of `<script type="application/ld+json">` blocks outside skipped elements. At most MAX_LD_BLOCKS. */
  ld: string[];
  /** JSON-LD blocks that were too large to keep. */
  ld_oversize: number;
}

export interface ScanOptions {
  /** True: stop at the end of the head (the proof). False: go on to the end of the page (JSON-LD may sit in the body). */
  head_only: boolean;
  /** Collect JSON-LD script blocks. */
  ld: boolean;
}

export const MAX_LD_BLOCKS = 20;
export const MAX_LD_BYTES = 256 * 1024;
const MAX_METAS = 500;
const MAX_ATTRS = 32;
const MAX_ATTR_VALUE = 2048;

/** Elements that may stand before the body without ending the head. */
const HEAD_OK: ReadonlySet<string> = new Set([
  'html',
  'head',
  'meta',
  'link',
  'title',
  'base',
  'style',
  'script',
  'noscript',
  'template',
]);

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

interface Tag {
  name: string;
  attrs: Record<string, string>;
  /** Index just after the closing '>'. */
  end: number;
}

/** Reads a start tag at s[i] === '<' followed by a letter. Null when the tag never ends. */
function readStartTag(s: string, i: number): Tag | null {
  const n = s.length;
  let k = i + 1;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (isSpace(c) || c === 47 /* / */ || c === 62 /* > */) break;
    k += 1;
  }
  const name = s.slice(i + 1, k).toLowerCase();
  const attrs: Record<string, string> = {};
  let count = 0;
  for (;;) {
    while (k < n && (isSpace(s.charCodeAt(k)) || s.charCodeAt(k) === 47)) k += 1;
    if (k >= n) return null;
    if (s.charCodeAt(k) === 62) return { name, attrs, end: k + 1 };
    const a0 = k;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (isSpace(c) || c === 61 /* = */ || c === 62 || c === 47) break;
      k += 1;
    }
    // A name that starts with '=' or is empty would not move on: take one character.
    if (k === a0) k += 1;
    const key = s.slice(a0, k).toLowerCase();
    let m = k;
    while (m < n && isSpace(s.charCodeAt(m))) m += 1;
    let value = '';
    if (m < n && s.charCodeAt(m) === 61) {
      m += 1;
      while (m < n && isSpace(s.charCodeAt(m))) m += 1;
      if (m >= n) return null;
      const q = s.charCodeAt(m);
      if (q === 34 || q === 39) {
        const close = s.indexOf(q === 34 ? '"' : "'", m + 1);
        if (close === -1) return null;
        value = s.slice(m + 1, close);
        k = close + 1;
      } else {
        const v0 = m;
        while (m < n && !isSpace(s.charCodeAt(m)) && s.charCodeAt(m) !== 62) m += 1;
        value = s.slice(v0, m);
        k = m;
      }
    }
    if (count < MAX_ATTRS && !Object.hasOwn(attrs, key)) {
      attrs[key] = value.length > MAX_ATTR_VALUE ? value.slice(0, MAX_ATTR_VALUE) : value;
      count += 1;
    }
  }
}

/** Index just after the '>' that ends the tag starting at s[i], or -1. Quotes do not matter here. */
const afterGt = (s: string, from: number): number => {
  const gt = s.indexOf('>', from);
  return gt === -1 ? -1 : gt + 1;
};

function readName(s: string, from: number): { name: string; end: number } {
  let k = from;
  const n = s.length;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (isLetter(c) || isDigit(c) || c === 45) k += 1;
    else break;
  }
  return { name: s.slice(from, k).toLowerCase(), end: k };
}

const RAW_CLOSERS: Record<string, RegExp> = {
  script: /<\/script/gi,
  style: /<\/style/gi,
  title: /<\/title/gi,
  textarea: /<\/textarea/gi,
};

export function scanHtml(html: string, o: ScanOptions): HtmlScan {
  const out: HtmlScan = { metas: [], ld: [], ld_oversize: 0 };
  if (typeof html !== 'string') return out;
  const s = html;
  const n = s.length;
  // Depth of noscript and template: only the kinds matter, so a counter per kind is not enough (a wrong end
  // tag must not close the other kind); a plain array of names does it.
  const stack: string[] = [];
  let inHead = true;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (stack.length === 0 && inHead) {
      // Any text that is not white space puts the page in its body.
      for (let k = i; k < textEnd; k += 1) {
        if (!isSpace(s.charCodeAt(k))) {
          inHead = false;
          break;
        }
      }
      if (!inHead && o.head_only) break;
    }
    if (lt === -1) break;
    const c1 = lt + 1 < n ? s.charCodeAt(lt + 1) : 0;
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e === -1) break;
      i = e + 3;
      continue;
    }
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */) {
      const e = afterGt(s, lt + 2);
      if (e === -1) break;
      i = e;
      continue;
    }
    if (c1 === 47 /* / */) {
      const { name, end } = readName(s, lt + 2);
      const e = afterGt(s, end);
      if (e === -1) break;
      if (name === 'noscript' || name === 'template') {
        if (stack.length > 0 && stack[stack.length - 1] === name) stack.pop();
      } else if (name === 'head' && stack.length === 0) {
        inHead = false;
        if (o.head_only) break;
      }
      i = e;
      continue;
    }
    if (!isLetter(c1)) {
      // A '<' that starts no tag is text.
      if (stack.length === 0 && inHead) {
        inHead = false;
        if (o.head_only) break;
      }
      i = lt + 1;
      continue;
    }
    const tag = readStartTag(s, lt);
    if (tag === null) break;
    const raw = RAW_CLOSERS[tag.name];
    if (raw !== undefined) {
      raw.lastIndex = tag.end;
      const m = raw.exec(s);
      if (m === null) break;
      const after = afterGt(s, m.index + 2);
      if (after === -1) break;
      if (
        tag.name === 'script' &&
        o.ld &&
        stack.length === 0 &&
        (tag.attrs['type'] ?? '').split(';')[0]!.trim().toLowerCase() === 'application/ld+json'
      ) {
        const len = m.index - tag.end;
        if (len > MAX_LD_BYTES) out.ld_oversize += 1;
        else out.ld.push(s.slice(tag.end, m.index));
        if (out.ld.length >= MAX_LD_BLOCKS) break;
      }
      i = after;
      continue;
    }
    if (tag.name === 'noscript' || tag.name === 'template') {
      stack.push(tag.name);
      i = tag.end;
      continue;
    }
    if (stack.length === 0) {
      if (tag.name === 'meta' && inHead && out.metas.length < MAX_METAS) out.metas.push(tag.attrs);
      if (!HEAD_OK.has(tag.name) && inHead) {
        inHead = false;
        if (o.head_only) break;
      }
    }
    i = tag.end;
  }
  return out;
}
