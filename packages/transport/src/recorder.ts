import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATIONS, PATHS, SANDBOX_API } from './endpoints';
import { FixtureFileSchema } from './fixture-schema';
import type { FixtureFile } from './fixture-schema';
import { buildIndex } from './fixture-store';
import type { PayPalOperation } from '@umsbx/contracts';

// Offline fixture recorder (MVP-B lane B-L3, acceptance B-13). It turns the owner's raw spike
// output, or a transport call log, into `sandbox-recording` fixtures. It never opens a connection
// and never reads a credential: input is a JSON value, output is files under
// fixtures/paypal/sandbox-recordings/ only.
//
//  - Redaction is by key (credentials, tokens, emails, payer id, names, addresses, phones) and by
//    pattern (bearer/basic values, JWT-like, long base64/hex, emails in any encoding, URL queries).
//    Headers are allow-listed. JSON held inside a string is parsed and redacted like the document.
//  - PayPal debug ids, statuses, error names and the sandbox order/capture ids are kept. Ids are
//    replaced by stable synthetic ones only when `synthetic_ids` is set.
//  - Nothing is written unless a second, independent check finds no residue and no caller canary
//    (raw, case-folded, URL-encoded, base64, JSON-escaped). A live or non-sandbox host refuses the
//    whole input.
//  - Refusals and summaries carry codes and counts, never values.

export type RefusalCode =
  | 'bad_input'
  | 'bad_option'
  | 'live_host'
  | 'too_deep'
  | 'residue'
  | 'canary_survived'
  | 'duplicate'
  | 'unsafe_target'
  | 'exists'
  | 'invalid_file'
  | 'tree_invalid';
export interface Refusal {
  code: RefusalCode;
  /** Where, never what: a file name, a field name or a rule label. */
  where: string;
}
class Refuse extends Error {
  readonly code: RefusalCode;
  readonly where: string;
  constructor(code: RefusalCode, where: string) {
    super(`${code}: ${where}`);
    this.code = code;
    this.where = where;
  }
}

export interface RecorderOptions {
  /** ISO UTC time the owner ran the calls; required (the recorder never reads a clock). */
  recorded_at: string;
  /** Where the recording came from, in words. Prefixed with "sandbox-recording: " when it is not. */
  origin: string;
  /** Replace order/capture/refund ids with stable synthetic ones. Off by default. */
  synthetic_ids?: boolean;
  /** Literal values that must not survive (client id, secret, test emails). Never printed. */
  canaries?: readonly string[];
  /** Serialiser; the CLI passes prettier so the stored bytes (and their hash) are final. */
  format?: (json: string) => string | Promise<string>;
}

export interface BuiltFile {
  name: string;
  text: string;
}
export interface Summary {
  files: number;
  redactions: Record<string, number>;
  ids_replaced: number;
  debug_ids_kept: number;
  statuses_kept: number;
}
export type BuildResult =
  { ok: true; files: BuiltFile[]; summary: Summary } | { ok: false; refusal: Refusal };

const REDACTED = '[redacted]';
const MAX_DEPTH = 40;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SANDBOX_HOST = new URL(SANDBOX_API).hostname;
const SANDBOX_SUFFIX = ['', 'sandbox', 'paypal', 'com'].join('.');
const DOCS_HOST = ['developer', 'paypal', 'com'].join('.');
const isSandboxHost = (h: string) => h === SANDBOX_HOST || h.endsWith(SANDBOX_SUFFIX);

// A live PayPal API host or the bare apex anywhere in a string refuses the input.
const LIVE_API_LABELS =
  'api-m|api|api-3t|api-aa|api-aa-3t|ipnpb|www|svcs|payflowpro|pilot-payflowpro';
const LIVE_HOST = new RegExp(
  `(?<![a-z0-9.-])(?:(?:${LIVE_API_LABELS})\\.)?paypal\\.com(?![a-z0-9-])`,
  'i',
);

// ---------------------------------------------------------------------------------------------
// Key classes. Keys are compared compacted: case, spaces, dashes, underscores and dots ignored.
// ---------------------------------------------------------------------------------------------
// Characters that hide a key's name from a comparison: controls, spaces, zero-width marks, separators.
const isHidden = (ch: string): boolean => {
  const c = ch.codePointAt(0) ?? 0;
  return (
    c <= 0x20 ||
    c === 0x7f ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2060 ||
    c === 0xfeff ||
    ch === '_' ||
    ch === '.' ||
    ch === '-' ||
    /\s/u.test(ch)
  );
};
const compact = (k: string): string =>
  [...k.normalize('NFKC')]
    .filter((ch) => !isHidden(ch))
    .join('')
    .toLowerCase();

type KeyClass = 'credential' | 'payer id' | 'email' | 'person name' | 'address' | 'phone';
const CREDENTIAL =
  /secret|password|passwd|passcode|assertion|credential|apikey|privatekey|token$|nonce|signature|^sig$|transmissionsig|sessionid|^authorization$|proxyauthorization|^cookie$|setcookie|^clientid$|^appid$/;
function classOf(rawKey: string): KeyClass | null {
  const k = compact(rawKey);
  if (CREDENTIAL.test(k)) return 'credential';
  if (k === 'payerid' || k === 'accountid') return 'payer id';
  if (/email/.test(k)) return 'email';
  if (/^(givenname|surname|fullname|familyname|firstname|lastname|middlename|nickname)$/.test(k))
    return 'person name';
  if (/^address|addressline|adminarea|postalcode|^zip|street/.test(k)) return 'address';
  if (/phone|nationalnumber|mobile/.test(k)) return 'phone';
  return null;
}
// `name` is only personal in a payer-like context (an error `name` such as UNPROCESSABLE_ENTITY stays).
const NAME_CONTEXT = new Set([
  'payer',
  'shipping',
  'paymentsource',
  'billing',
  'recipient',
  'cardholder',
  'paypal',
  'card',
  'venmo',
]);
const PERSON_SIBLINGS = ['givenname', 'surname', 'fullname'];

// ---------------------------------------------------------------------------------------------
// Tally: counts per category, never values.
// ---------------------------------------------------------------------------------------------
class Tally {
  readonly counts = new Map<string, number>();
  add(category: string, n = 1): void {
    this.counts.set(category, (this.counts.get(category) ?? 0) + n);
  }
  lines(): string[] {
    return [...this.counts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([c, n]) => `${c}: ${n} value(s) replaced`);
  }
}

// ---------------------------------------------------------------------------------------------
// Pattern scrub for one string.
// ---------------------------------------------------------------------------------------------
const EMAIL_G = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\)]+|\/v\d\/[^\s"'<>\\)]*/gi;
const AUTH_VALUE = /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const JWT_A = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g;
const JWT_B = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g;
const LONG_A = /[A-Za-z0-9+_=-]{40,}/g;
const LONG_B = /[A-Za-z0-9+/=]{40,}/g;
const HEX32 = /\b[0-9a-f]{32,}\b/gi;
const ID_SHAPE = /^[A-Z0-9]{5,36}$/;

/** Folds the common disguises of "@" and "." so an encoded email is still seen. */
function unmask(s: string): string {
  let t = s.normalize('NFKC').replace(/[。．｡]/g, '.');
  t = t
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
    .replace(/\\u0040|\\x40/gi, '@')
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
  for (let i = 0; i < 3; i += 1) {
    try {
      const d = decodeURIComponent(t);
      if (d === t) break;
      t = d;
    } catch {
      break;
    }
  }
  return t;
}

function scrubUrl(raw: string, st: Tally): string {
  let trail = '';
  let u = raw;
  const m = /[.,;:!?]+$/.exec(u);
  if (m) {
    trail = m[0];
    u = u.slice(0, -trail.length);
  }
  const relative = u.startsWith('/');
  let url: URL;
  try {
    url = new URL(u, 'https://relative.invalid');
  } catch {
    st.add('foreign url', 1);
    return `[redacted-url]${trail}`;
  }
  if (!relative) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      st.add('foreign url', 1);
      return `[redacted-url]${trail}`;
    }
    const h = url.hostname.toLowerCase();
    if (!isSandboxHost(h) && h !== DOCS_HOST) {
      st.add('foreign url', 1);
      return `[redacted-url]${trail}`;
    }
  }
  if (url.username || url.password) st.add('url userinfo', 1);
  const segs = url.pathname.split('/').map((seg) => {
    let dec = seg;
    try {
      dec = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    if (EMAIL.test(unmask(dec)) || /[A-Za-z0-9+_=-]{40,}/.test(dec)) {
      st.add('url path segment', 1);
      return 'redacted';
    }
    return seg;
  });
  let query = '';
  const isCert = url.pathname.includes('/certs/');
  const keep: [string, string][] = [];
  if (!isCert) {
    for (const [k, v] of url.searchParams) {
      if (ID_SHAPE.test(v)) keep.push([k, v]);
      else st.add('url query value', 1);
    }
  } else if (url.search.length > 1) {
    st.add('cert url query', 1);
  }
  if (url.hash.length > 1) st.add('url fragment', 1);
  if (keep.length > 0)
    query = `?${keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  const base = relative ? '' : `${url.protocol}//${url.host}`;
  return `${base}${segs.join('/')}${query}${trail}`;
}

function scrubText(input: string, st: Tally): string {
  const flat = input.normalize('NFKC').replace(/[。．｡]/g, '.');
  let decoded = flat;
  try {
    decoded = decodeURIComponent(flat);
  } catch {
    /* not percent-encoded */
  }
  if (LIVE_HOST.test(flat) || LIVE_HOST.test(decoded))
    throw new Refuse('live_host', 'string value');

  let s = input;
  const stash: string[] = [];
  const hold = (v: string) => {
    stash.push(v);
    return `\uE000${stash.length - 1}\uE001`;
  };
  s = s.replace(URL_RE, (u) => hold(scrubUrl(u, st)));
  s = s.replace(EMAIL_G, () => {
    st.add('email address pattern', 1);
    return 'email-redacted';
  });
  if (EMAIL.test(unmask(s))) {
    st.add('encoded email pattern', 1);
    return REDACTED;
  }
  s = s.replace(AUTH_VALUE, (_m, scheme: string) => {
    st.add('bearer/basic value', 1);
    return `${scheme} ${REDACTED}`;
  });
  for (const [re, label] of [
    [JWT_A, 'jwt-like value'],
    [JWT_B, 'jwt-like value'],
    [LONG_A, 'long base64 value'],
    [LONG_B, 'long base64 value'],
    [HEX32, 'long hex value'],
  ] as const) {
    s = s.replace(re, () => {
      st.add(label, 1);
      return REDACTED;
    });
  }
  return s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => stash[Number(i)] ?? '');
}

function looksLikeForm(s: string): boolean {
  return /^[A-Za-z0-9_.-]+=[^&\s]*(&[A-Za-z0-9_.-]+=[^&\s]*)*$/.test(s);
}

// ---------------------------------------------------------------------------------------------
// Deep walk.
// ---------------------------------------------------------------------------------------------
function scrubValue(node: unknown, st: Tally, ancestors: string[], depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Refuse('too_deep', 'value nesting');
  if (typeof node === 'string') return scrubString(node, st, ancestors, depth);
  if (node === null || typeof node === 'number' || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map((v) => scrubValue(v, st, ancestors, depth + 1));
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const siblings = Object.keys(obj).map(compact);
    const personal = PERSON_SIBLINGS.some((k) => siblings.includes(k));
    const entries: [string, unknown][] = [];
    for (const [rawKey, v] of Object.entries(obj)) {
      const key = scrubText(rawKey.trim(), st);
      let cls = classOf(rawKey);
      if (cls === null && compact(rawKey) === 'name') {
        if (personal || ancestors.some((a) => NAME_CONTEXT.has(a))) cls = 'person name';
      }
      if (cls !== null) {
        st.add(`key ${cls}`, 1);
        entries.push([key, REDACTED]);
        continue;
      }
      entries.push([key, scrubValue(v, st, [...ancestors, compact(rawKey)], depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  return String(node);
}

function scrubString(s: string, st: Tally, ancestors: string[], depth: number): unknown {
  const t = s.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const parsed: unknown = JSON.parse(t);
      st.add('json held in a string', 1);
      return JSON.stringify(scrubValue(parsed, st, ancestors, depth + 1));
    } catch {
      /* not JSON: fall through to the text rules */
    }
  }
  return scrubText(s, st);
}

/** A top-level body: JSON text, a form string (the OAuth request), or other text. */
function scrubBody(raw: unknown, st: Tally): unknown {
  const v = parseBodyText(raw);
  if (typeof v === 'string' && looksLikeForm(v.trim())) {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of new URLSearchParams(v.trim())) obj[k] = val;
    st.add('form body', 1);
    const out = scrubValue(obj, st, [], 1) as Record<string, unknown>;
    return new URLSearchParams(
      Object.entries(out).map(([k, x]): [string, string] => [k, String(x)]),
    ).toString();
  }
  return scrubValue(v, st, [], 0);
}

// ---------------------------------------------------------------------------------------------
// Headers: allow-list by lower-cased trimmed name; authorization becomes a placeholder.
// ---------------------------------------------------------------------------------------------
const ALLOWED_HEADERS = new Set([
  'content-type',
  'accept',
  'prefer',
  'paypal-debug-id',
  'paypal-request-id',
  'retry-after',
  'date',
]);
const MIME = /^[\w.+*-]+\/[\w.+*-]+$/;
const MIME_PARAM = /^(?:charset|q|version)=[\w.-]+$/i;
function validMime(v: string): boolean {
  return v.split(',').every((part) => {
    const [type, ...params] = part.split(';').map((x) => x.trim());
    return MIME.test(type ?? '') && params.every((p) => MIME_PARAM.test(p));
  });
}
// A header value must have the shape its name promises; anything else is dropped, not scrubbed.
const HEADER_SHAPE: Record<string, (v: string) => boolean> = {
  'content-type': validMime,
  accept: validMime,
  prefer: (v) => /^[\w=,;"\s-]{1,60}$/.test(v),
  'paypal-debug-id': (v) => /^[A-Za-z0-9-]{6,40}$/.test(v),
  'paypal-request-id': (v) => /^[A-Za-z0-9._-]{6,64}$/.test(v),
  'retry-after': (v) => /^\d{1,6}$/.test(v) || /^[A-Za-z0-9,: ]{10,40}$/.test(v),
  date: (v) => /^[A-Za-z0-9,: ]{10,40}$/.test(v),
};
const HOST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'referrer',
  'x-forwarded-host',
  'forwarded',
]);

function headerName(k: string): string {
  return [...k.normalize('NFKC')]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return (
        c > 0x20 && c !== 0x7f && !(c >= 0x200b && c <= 0x200f) && c !== 0x2060 && c !== 0xfeff
      );
    })
    .join('')
    .toLowerCase();
}

function requireSandboxHost(value: string, where: string): void {
  const v = value
    .normalize('NFKC')
    .replace(/[。．｡]/g, '.')
    .trim();
  let h: string;
  try {
    h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    throw new Refuse('live_host', where);
  }
  if (!isSandboxHost(h)) throw new Refuse('live_host', where);
}

function scrubHeaders(
  raw: unknown,
  side: 'request' | 'response',
  st: Tally,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Refuse('bad_input', `${side} headers`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = headerName(k);
    const value = Array.isArray(v) ? v.map(String).join(', ') : String(v);
    if (HOST_HEADERS.has(name)) {
      if (side === 'request') requireSandboxHost(value, `${side} header host`);
      st.add(`${side} header removed`, 1);
      continue;
    }
    if (name === 'authorization' && side === 'request') {
      out.authorization = REDACTED;
      st.add('request header authorization', 1);
      continue;
    }
    if (!/^[a-z0-9-]+$/.test(name) || !ALLOWED_HEADERS.has(name)) {
      st.add(`${side} header removed`, 1);
      continue;
    }
    if (!HEADER_SHAPE[name]?.(value.trim())) {
      st.add(`${side} header value rejected`, 1);
      continue;
    }
    out[name] = value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Input parsing.
// ---------------------------------------------------------------------------------------------
interface Parsed {
  scenario: string;
  operation: PayPalOperation;
  step: number;
  request: FixtureFile['request'];
  response: FixtureFile['response'];
  path_id: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseBodyText(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  if (t === '') return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return v;
  }
}

function pathId(op: PayPalOperation, path: string): string | null {
  const spec = PATHS[op];
  const esc = spec.template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^${esc.replace('\\{id\\}', '([A-Z0-9]{1,36})').replace('\\{cert\\}', '(.+)')}$`,
  );
  const m = re.exec(path);
  if (!m) throw new Refuse('bad_input', 'request path does not match the operation');
  return spec.template.includes('{id}') ? (m[1] ?? null) : null;
}

function requestPath(req: Record<string, unknown>): string {
  const p = req.url ?? req.path ?? req.uri ?? req.href;
  if (typeof p !== 'string') throw new Refuse('bad_input', 'request path');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p.trim())) {
    requireSandboxHost(p, 'request url');
    return new URL(p.trim()).pathname;
  }
  return p.split(/[?#]/)[0] ?? p;
}

function hostFields(req: Record<string, unknown>): void {
  for (const k of Object.keys(req)) {
    const c = compact(k);
    if (['baseurl', 'host', 'hostname', 'origin', 'endpoint', 'referer', 'referrer'].includes(c)) {
      const v = req[k];
      if (typeof v === 'string') requireSandboxHost(v, 'request host field');
    }
  }
}

function listOf(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (isObj(input) && Array.isArray(input.exchanges)) return input.exchanges;
  throw new Refuse('bad_input', 'input must be an array or { exchanges: [...] }');
}

function parseExchanges(input: unknown, st: Tally): Parsed[] {
  const list = listOf(input);
  if (list.length === 0) throw new Refuse('bad_input', 'no exchanges');
  const counters = new Map<string, number>();
  const seen = new Set<string>();
  const out: Parsed[] = [];
  list.forEach((e, i) => {
    const where = `exchange ${i + 1}`;
    if (!isObj(e)) throw new Refuse('bad_input', where);
    const scenario = e.scenario;
    if (typeof scenario !== 'string' || !/^[a-z0-9_]{1,64}$/.test(scenario))
      throw new Refuse('bad_input', `${where} scenario`);
    const operation = e.operation;
    if (typeof operation !== 'string' || !(OPERATIONS as string[]).includes(operation))
      throw new Refuse('bad_input', `${where} operation`);
    const op = operation as PayPalOperation;
    const req = e.request;
    if (!isObj(req)) throw new Refuse('bad_input', `${where} request`);
    hostFields(req);
    const spec = PATHS[op];
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : spec.method;
    if (method !== spec.method) throw new Refuse('bad_input', `${where} method`);
    const pid = pathId(op, requestPath(req));
    const key = `${scenario}|${op}`;
    const given = e.step;
    if (given !== undefined && (typeof given !== 'number' || !Number.isInteger(given) || given < 1))
      throw new Refuse('bad_input', `${where} step`);
    const step = typeof given === 'number' ? given : (counters.get(key) ?? 0) + 1;
    counters.set(key, step);
    if (seen.has(`${key}|${step}`)) throw new Refuse('duplicate', where);
    seen.add(`${key}|${step}`);

    const request: FixtureFile['request'] = {
      method: spec.method,
      path_template: spec.template,
      headers: scrubHeaders(req.headers, 'request', st),
      body: scrubBody(req.body, st),
    };

    const res = e.response ?? e.result;
    if (!isObj(res)) throw new Refuse('bad_input', `${where} response`);
    let response: FixtureFile['response'];
    if (res.timeout === true || res.kind === 'timeout') response = { timeout: true };
    else if (
      (res.kind === undefined || res.kind === 'response') &&
      typeof res.status === 'number'
    ) {
      if (!Number.isInteger(res.status) || res.status < 100 || res.status > 599)
        throw new Refuse('bad_input', `${where} status`);
      response = {
        status: res.status,
        headers: scrubHeaders(res.headers, 'response', st),
        body: scrubBody(res.body, st),
      };
    } else throw new Refuse('bad_input', `${where} response kind is not recordable`);
    out.push({ scenario, operation: op, step, request, response, path_id: pid });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Synthetic ids (only on request).
// ---------------------------------------------------------------------------------------------
type IdKind = 'ORD' | 'CAP' | 'REF';
const ID_VALUE = /^[A-Z0-9]{5,36}$/;
const kindForOp = (op: PayPalOperation): IdKind | null =>
  op === 'create_order' || op === 'get_order' || op === 'capture_order'
    ? 'ORD'
    : op === 'get_capture'
      ? 'CAP'
      : op === 'refund_capture' || op === 'get_refund'
        ? 'REF'
        : null;
const pathKind = (op: PayPalOperation): IdKind | null =>
  op === 'get_order' || op === 'capture_order'
    ? 'ORD'
    : op === 'get_capture' || op === 'refund_capture'
      ? 'CAP'
      : op === 'get_refund'
        ? 'REF'
        : null;

function collectIds(p: Parsed, into: Map<string, IdKind>): void {
  const add = (v: unknown, k: IdKind | null) => {
    if (k && typeof v === 'string' && ID_VALUE.test(v) && !into.has(v)) into.set(v, k);
  };
  add(p.path_id, pathKind(p.operation));
  if (!('status' in p.response)) return;
  const body = p.response.body;
  if (!isObj(body)) return;
  add(body.id, kindForOp(p.operation));
  const units = Array.isArray(body.purchase_units) ? body.purchase_units : [];
  for (const u of units) {
    const pay = isObj(u) && isObj(u.payments) ? u.payments : null;
    for (const [field, kind] of [
      ['captures', 'CAP'],
      ['refunds', 'REF'],
    ] as const) {
      const arr = pay && Array.isArray(pay[field]) ? (pay[field] as unknown[]) : [];
      for (const c of arr) if (isObj(c)) add(c.id, kind);
    }
  }
}

function mapStrings(node: unknown, fn: (s: string) => string): unknown {
  if (typeof node === 'string') return fn(node);
  if (Array.isArray(node)) return node.map((v) => mapStrings(v, fn));
  if (isObj(node))
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapStrings(v, fn)]));
  return node;
}

// ---------------------------------------------------------------------------------------------
// Independent residue check. Runs on the final text; used by build and again by write.
// ---------------------------------------------------------------------------------------------
const FOLDED_BEARER = /\b(?:Bearer|Basic|Digest)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}/i;

export function canaryForms(c: string): string[] {
  const b64 = Buffer.from(c).toString('base64');
  const forms = new Set<string>([
    c,
    encodeURIComponent(c),
    JSON.stringify(c).slice(1, -1),
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(c).toString('base64url'),
    Buffer.from(c).toString('hex'),
  ]);
  if (c.length >= 24) forms.add(c.slice(0, 16));
  return [...forms].map((f) => f.toLowerCase());
}

export function residueRule(text: string, canaries: readonly string[]): string | null {
  const low = text.toLowerCase();
  for (const c of canaries) {
    if (c.length < 4) return 'canary too short';
    if (canaryForms(c).some((f) => low.includes(f))) return 'canary';
  }
  if (text.includes('CANARY_')) return 'canary marker';
  if (EMAIL.test(text) || EMAIL.test(unmask(text))) return 'email';
  if (FOLDED_BEARER.test(text)) return 'bearer value';
  if (new RegExp(JWT_A.source).test(text) || new RegExp(JWT_B.source).test(text))
    return 'jwt-like value';
  const noPaths = text.replace(/\/v\d\/[A-Za-z0-9/_.-]*/g, '/v');
  if (/[A-Za-z0-9+_=-]{40,}/.test(noPaths) || /[A-Za-z0-9+/=]{40,}/.test(noPaths))
    return 'long token';
  if (LIVE_HOST.test(text)) return 'live host';
  for (const m of text.matchAll(/https?:\/\/([^/"\s?#:\\]+)/gi)) {
    const h = (m[1] ?? '').toLowerCase();
    if (!isSandboxHost(h) && h !== DOCS_HOST) return 'non-sandbox host';
  }
  if (/\/certs\/[^"\s]*\?/.test(text)) return 'cert url query';
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'not json';
  }
  let bad: string | null = null;
  const visit = (n: unknown, depth: number): void => {
    if (bad || depth > MAX_DEPTH + 5) return;
    if (Array.isArray(n)) n.forEach((v) => visit(v, depth + 1));
    else if (isObj(n)) {
      for (const [k, v] of Object.entries(n)) {
        const cls = classOf(k);
        if (cls && v !== null && v !== false && v !== '' && v !== REDACTED) {
          bad = `unredacted ${cls} key`;
          return;
        }
        visit(v, depth + 1);
      }
    }
  };
  visit(doc, 0);
  return bad;
}

// ---------------------------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------------------------
const defaultFormat = (json: string): string => `${json}\n`;

function checkOptions(o: RecorderOptions): void {
  if (typeof o.recorded_at !== 'string' || !ISO_UTC.test(o.recorded_at))
    throw new Refuse('bad_option', 'recorded_at must be an ISO UTC time');
  if (typeof o.origin !== 'string' || o.origin.trim().length < 10)
    throw new Refuse('bad_option', 'origin needs a sentence of at least 10 characters');
  for (const c of o.canaries ?? [])
    if (typeof c !== 'string' || c.length < 4) throw new Refuse('bad_option', 'canary too short');
}

export async function buildRecordings(input: unknown, opts: RecorderOptions): Promise<BuildResult> {
  try {
    checkOptions(opts);
    const total = new Tally();
    const parsed = parseExchanges(input, total);
    const canaries = opts.canaries ?? [];

    const synth = new Map<string, string>();
    const perKind = new Map<string, number>();
    const tagOf = (scenario: string) =>
      scenario
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 12);
    // numbering is first-seen within the scenario that first used the id
    if (opts.synthetic_ids) {
      for (const p of parsed) {
        const mine = new Map<string, IdKind>();
        collectIds(p, mine);
        for (const [id, kind] of mine) {
          if (synth.has(id)) continue;
          const k = `${p.scenario}|${kind}`;
          const n = (perKind.get(k) ?? 0) + 1;
          perKind.set(k, n);
          synth.set(id, `SBX${tagOf(p.scenario)}${kind}${String(n).padStart(5, '0')}`);
        }
      }
    }
    const replaceIds = (s: string): string => {
      let t = s;
      for (const [id, to] of synth)
        t = t.replace(new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`, 'g'), to);
      return t;
    };

    const fmt = opts.format ?? defaultFormat;
    const files: BuiltFile[] = [];
    let debugIds = 0;
    let statuses = 0;
    const origin = (() => {
      const t = new Tally();
      const o = String(scrubText(opts.origin.trim(), t));
      return o.startsWith('sandbox-recording:') ? o : `sandbox-recording: ${o}`;
    })();

    for (const p of parsed) {
      let fx: FixtureFile = {
        meta: {
          source: 'sandbox-recording',
          scenario: p.scenario,
          operation: p.operation,
          step: p.step,
          recorded_at: opts.recorded_at as FixtureFile['meta']['recorded_at'],
          origin,
          redactions: [],
          ...(p.path_id ? { expected_id: p.path_id } : {}),
        },
        request: p.request,
        response: p.response,
      };
      if (opts.synthetic_ids) fx = mapStrings(fx, replaceIds) as FixtureFile;
      if ('status' in fx.response) {
        statuses += 1;
        if (fx.response.headers['paypal-debug-id']) debugIds += 1;
      }
      files.push({
        name: `${p.scenario}__${p.operation}__${p.step}.json`,
        text: JSON.stringify(fx),
      });
    }

    // Redaction notes: the run-wide tally (counts and categories only) goes into every file.
    const notes = [
      'recorder: key and pattern redaction applied; headers allow-listed',
      ...(opts.synthetic_ids
        ? [`ids: ${synth.size} order/capture/refund id(s) replaced by synthetic ids (flag)`]
        : ['ids: kept (sandbox play ids)']),
      ...total.lines(),
    ];
    const out: BuiltFile[] = [];
    for (const f of files) {
      const fx = JSON.parse(f.text) as FixtureFile;
      fx.meta.redactions = notes;
      const checked = FixtureFileSchema.safeParse(fx);
      if (!checked.success)
        throw new Refuse('bad_input', `${f.name} does not fit the fixture schema`);
      const text = await fmt(JSON.stringify(fx, null, 2));
      const rule = residueRule(text, canaries);
      if (rule !== null) {
        throw new Refuse(rule === 'canary' ? 'canary_survived' : 'residue', `${f.name} (${rule})`);
      }
      out.push({ name: f.name, text });
    }

    return {
      ok: true,
      files: out,
      summary: {
        files: out.length,
        redactions: Object.fromEntries(total.counts),
        ids_replaced: synth.size,
        debug_ids_kept: debugIds,
        statuses_kept: statuses,
      },
    };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, refusal: { code: e.code, where: e.where } };
    throw e;
  }
}

/** Counts and categories only. */
export function formatSummary(s: Summary): string {
  const lines = [
    `recorder: ${s.files} file(s) built`,
    `  debug ids kept: ${s.debug_ids_kept}; statuses kept: ${s.statuses_kept}; ids replaced: ${s.ids_replaced}`,
    ...Object.entries(s.redactions)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([c, n]) => `  ${c}: ${n}`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Write: only inside fixtures/paypal/sandbox-recordings, then refresh fixtures/paypal/index.json.
// ---------------------------------------------------------------------------------------------
export type WriteResult = { ok: true; written: string[] } | { ok: false; refusal: Refusal };
const NAME_RE = /^[a-z0-9_]{1,64}__[a-z_]{1,40}__[1-9][0-9]{0,5}\.json$/;

async function existsNoFollow(p: string): Promise<'none' | 'file' | 'symlink' | 'dir'> {
  try {
    const s = await lstat(p);
    return s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

export async function writeRecordings(
  root: string,
  files: readonly BuiltFile[],
  opts: { overwrite?: boolean; canaries?: readonly string[] } = {},
): Promise<WriteResult> {
  const refuse = (code: RefusalCode, where: string): WriteResult => ({
    ok: false,
    refusal: { code, where },
  });
  if (files.length === 0) return refuse('bad_input', 'no files');
  const names = new Set<string>();
  for (const f of files) {
    if (!NAME_RE.test(f.name) || names.has(f.name)) return refuse('invalid_file', 'file name');
    names.add(f.name);
    let fx: FixtureFile;
    try {
      fx = FixtureFileSchema.parse(JSON.parse(f.text)) as FixtureFile;
    } catch {
      return refuse('invalid_file', `${f.name} (schema)`);
    }
    if (fx.meta.source !== 'sandbox-recording' || fx.meta.recorded_at === null)
      return refuse('invalid_file', `${f.name} (label)`);
    if (f.name !== `${fx.meta.scenario}__${fx.meta.operation}__${fx.meta.step}.json`)
      return refuse('invalid_file', `${f.name} (name differs from meta)`);
    const rule = residueRule(f.text, opts.canaries ?? []);
    if (rule !== null)
      return refuse(rule === 'canary' ? 'canary_survived' : 'residue', `${f.name} (${rule})`);
  }

  const paypal = join(root, 'fixtures', 'paypal');
  const dir = join(paypal, 'sandbox-recordings');
  for (const p of [join(root, 'fixtures'), paypal, dir]) {
    if ((await existsNoFollow(p)) === 'symlink')
      return refuse('unsafe_target', 'target folder is a symlink');
  }
  for (const f of files) {
    if (!opts.overwrite && (await existsNoFollow(join(dir, f.name))) !== 'none')
      return refuse('exists', f.name);
  }
  await mkdir(dir, { recursive: true });

  const undo: (() => Promise<void>)[] = [];
  const written: string[] = [];
  const rollback = async () => {
    for (const u of undo.reverse()) await u().catch(() => undefined);
  };
  try {
    for (const f of files) {
      const target = join(dir, f.name);
      const before = (await existsNoFollow(target)) === 'file' ? await readFile(target) : null;
      await writeFile(target, f.text, { flag: before === null ? 'wx' : 'w' });
      undo.push(
        before === null ? () => rm(target, { force: true }) : () => writeFile(target, before),
      );
      written.push(f.name);
    }
    let index: Awaited<ReturnType<typeof buildIndex>>;
    try {
      index = await buildIndex(paypal);
    } catch (e) {
      await rollback();
      const why = (e instanceof Error ? e.message : 'invalid').slice(0, 120);
      return refuse('tree_invalid', why);
    }
    const indexPath = join(paypal, 'index.json');
    const prior = (await existsNoFollow(indexPath)) === 'file' ? await readFile(indexPath) : null;
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    undo.push(
      prior === null ? () => rm(indexPath, { force: true }) : () => writeFile(indexPath, prior),
    );
    return { ok: true, written };
  } catch {
    await rollback();
    return refuse('invalid_file', 'write failed');
  }
}
