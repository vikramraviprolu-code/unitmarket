// FEED (E-02, nfr SOP 18, P19), adapted for the web import (POB-I1, D-089). Pure guards: no name lookup, no
// socket, no clock. A url, a resolved address and a response head are each checked here; feed-fetch.ts is the
// one place that acts on the answers. Every refusal is a fixed kind, never the text that caused it.
//
// The allow list is not configuration any more: the caller names, for each call, the one host it may reach
// (the publisher's verified domain, or the host whose proof is being checked). The address checks are the
// same as before. A call has one of two kinds: text (a page, a feed, the proof file) or image.

/** Largest body of any call (a feed, a page, a picture): 2 MB. */
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
/** The whole exchange, name lookup included: 5 s. */
export const FEED_DEADLINE_MS = 5000;
export const FEED_MAX_URL_CHARS = 2048;
const MAX_ADDRESSES = 32;

/** What a call may receive: text (page, feed, proof) or a picture. */
export type FeedKind = 'text' | 'image';

export type FeedRefusal =
  | 'feed_off'
  | 'bad_url'
  | 'not_https'
  | 'userinfo'
  | 'bad_port'
  | 'ip_literal'
  | 'host_not_allowed'
  | 'dns_failed'
  | 'private_address'
  | 'pin_mismatch'
  | 'redirect'
  | 'bad_status'
  | 'bad_content_type'
  | 'content_encoding'
  | 'too_large'
  | 'bad_body'
  | 'timeout'
  | 'network';

// ---------------------------------------------------------------------------------------------
// The url

/** A name the WHATWG parser would read as an IPv4 address: its last label is a number (decimal or 0x hex). */
const NUMERIC_LAST_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/i;
export function endsInNumber(host: string): boolean {
  const h = host.endsWith('.') ? host.slice(0, -1) : host;
  const last = h.slice(h.lastIndexOf('.') + 1);
  return NUMERIC_LAST_LABEL.test(last);
}
const looksLikeIp = (host: string): boolean =>
  host.startsWith('[') || host.includes(':') || endsInNumber(host);

export type FeedUrlCheck =
  { ok: true; host: string; path: string } | { ok: false; reason: FeedRefusal };

const refuse = (reason: FeedRefusal): { ok: false; reason: FeedRefusal } => ({ ok: false, reason });

/**
 * https only, no userinfo, port 443 only, no IP literal in any encoding, and the host must equal an entry
 * of the allow-list (exact, no wildcard). `path` is the path and query that will be requested.
 */
export function checkFeedUrl(raw: unknown, allow: readonly string[]): FeedUrlCheck {
  if (allow.length === 0) return refuse('feed_off');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > FEED_MAX_URL_CHARS)
    return refuse('bad_url');
  // Visible ASCII only (no space, control, bidi or non-ASCII character), and no backslash.
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes('\\')) return refuse('bad_url');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (scheme === null || scheme[1]!.toLowerCase() !== 'https' || !/^https:\/\//i.test(raw))
    return refuse('not_https');
  const rest = raw.slice('https://'.length);
  const authority = rest.slice(0, rest.search(/[/?#]|$/));
  if (authority.length === 0) return refuse('bad_url');
  if (authority.includes('@')) return refuse('userinfo');
  let hostText = authority;
  let port: string | null = null;
  if (!authority.startsWith('[')) {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      hostText = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }
  if (looksLikeIp(hostText) || authority.startsWith('[')) return refuse('ip_literal');
  if (port !== null && port !== '443') return refuse('bad_port');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return refuse('bad_url');
  }
  if (u.protocol !== 'https:') return refuse('not_https');
  if (u.username !== '' || u.password !== '') return refuse('userinfo');
  if (u.port !== '') return refuse('bad_port');
  const host = u.hostname.endsWith('.') ? u.hostname.slice(0, -1) : u.hostname;
  if (host.length === 0) return refuse('bad_url');
  // Percent escapes and other forms the first look did not see: check the parsed host again.
  if (looksLikeIp(host)) return refuse('ip_literal');
  if (!allow.includes(host)) return refuse('host_not_allowed');
  return { ok: true, host, path: `${u.pathname}${u.search}` };
}

// ---------------------------------------------------------------------------------------------
// An address

function parseV4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups, or null when the text is not a well formed IPv6 address (no zone, no brackets). */
function parseV6(s: string): number[] | null {
  if (s.length === 0 || s.length > 45 || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let text = s;
  const lastColon = text.lastIndexOf(':');
  let tail: number[] = [];
  if (text.includes('.')) {
    const v4 = parseV4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    text = text.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = text.split('::');
  if (dbl.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(dbl[0]!);
  if (head === null) return null;
  let all: number[];
  if (dbl.length === 2) {
    const back = groups(dbl[1]!);
    if (back === null) return null;
    const fill = 8 - head.length - back.length;
    if (fill < 1) return null;
    all = [...head, ...Array.from({ length: fill }, () => 0), ...back];
  } else {
    all = head;
  }
  if (all.length !== 8) return null;
  if (tail.length === 2) {
    all[6] = tail[0]!;
    all[7] = tail[1]!;
  }
  return all;
}

function publicV4(b: number[]): boolean {
  const [o1, o2, o3] = b as [number, number, number, number];
  if (o1 === 0 || o1 === 10 || o1 === 127) return false;
  if (o1 >= 224) return false; // multicast, reserved and broadcast
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return false; // CGNAT
  if (o1 === 169 && o2 === 254) return false; // link-local, the metadata address
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return false;
  if (o1 === 192 && o2 === 168) return false;
  if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return false; // 192.0.0.0/24, 192.0.2.0/24
  if (o1 === 192 && o2 === 88 && o3 === 99) return false; // 6to4 relay
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return false; // benchmarking
  if (o1 === 198 && o2 === 51 && o3 === 100) return false; // documentation
  if (o1 === 203 && o2 === 0 && o3 === 113) return false; // documentation
  return true;
}

function publicV6(g: number[]): boolean {
  // Only global unicast 2000::/3 can be public; everything else (loopback, unspecified, mapped, NAT64,
  // unique local, link-local, site-local, multicast) falls out here.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 protocol assignments, Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // documentation
  return true;
}

/** True only for a well formed address that is safe to connect to. Anything odd is false. */
export function isPublicAddress(ip: unknown): boolean {
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > 45) return false;
  const v4 = parseV4(ip);
  if (v4 !== null) return publicV4(v4);
  if (!ip.includes(':')) return false;
  const v6 = parseV6(ip);
  return v6 !== null && publicV6(v6);
}

export type ResolvedCheck =
  { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: 'private_address' };

/** Every resolved address must be public (one private answer among public ones is a refusal); pins the first. */
export function checkResolved(addresses: readonly unknown[]): ResolvedCheck {
  if (addresses.length === 0 || addresses.length > MAX_ADDRESSES)
    return { ok: false, reason: 'private_address' };
  for (const a of addresses)
    if (!isPublicAddress(a)) return { ok: false, reason: 'private_address' };
  const first = addresses[0] as string;
  return { ok: true, address: first, family: first.includes(':') ? 6 : 4 };
}

// ---------------------------------------------------------------------------------------------
// The response head

const TEXT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/feed+json',
  'application/ld+json',
  'application/atom+xml',
  'application/rss+xml',
  'application/xml',
  'text/xml',
  'text/html',
  'application/xhtml+xml',
  'text/plain',
]);
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Headers = Record<string, string | string[] | undefined>;

/**
 * The media type of an acceptable content type header, or null. For text a charset, when given, must be
 * UTF-8. For an image only the three types of the import count (no svg: it can hold script).
 */
export function feedMediaType(header: string | string[] | undefined, kind: FeedKind = 'text'): string | null {
  if (typeof header !== 'string') return null;
  const parts = header.split(';').map((p) => p.trim());
  const type = parts[0]!.toLowerCase();
  if (kind === 'image') return IMAGE_TYPES.has(type) ? type : null;
  if (!TEXT_TYPES.has(type)) return null;
  for (const p of parts.slice(1)) {
    const m = /^charset\s*=\s*"?([^"]*)"?$/i.exec(p);
    if (m !== null && m[1]!.trim().toLowerCase() !== 'utf-8') return null;
  }
  return type;
}

/** Null when the head is acceptable, otherwise the refusal kind. */
export function checkFeedHead(
  status: number,
  headers: Headers,
  kind: FeedKind = 'text',
): FeedRefusal | null {
  if (Number.isInteger(status) && status >= 300 && status <= 399) return 'redirect';
  if (status !== 200) return 'bad_status';
  if (feedMediaType(headers['content-type'], kind) === null) return 'bad_content_type';
  const enc = headers['content-encoding'];
  if (enc !== undefined) {
    const e = Array.isArray(enc) ? enc.join(',') : enc;
    if (e.trim().toLowerCase() !== '' && e.trim().toLowerCase() !== 'identity')
      return 'content_encoding';
  }
  const len = headers['content-length'];
  if (len !== undefined) {
    const l = Array.isArray(len) ? len.join(',') : len;
    if (!/^[0-9]{1,16}$/.test(l) || Number(l) > FEED_MAX_BYTES) return 'too_large';
  }
  return null;
}
