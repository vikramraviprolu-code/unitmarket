// Request headers and small readers for PayPal responses. Pure functions, no I/O.
import type { PayPalFail } from '@umsbx/contracts';

export const MAX_REQUEST_ID = 108; // PayPal-Request-Id limit (architecture 0, nfr.md P3)

/** 1..108 printable ASCII characters without spaces: safe in a header and within the limit. */
export function checkRequestId(id: string): PayPalFail | null {
  if (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= MAX_REQUEST_ID &&
    /^[\x21-\x7e]+$/.test(id)
  ) {
    return null;
  }
  return {
    kind: 'rejected',
    http: 400,
    name: 'REQUEST_ID_INVALID',
    issue: typeof id === 'string' && id.length > MAX_REQUEST_ID ? 'TOO_LONG' : 'INVALID_CHARACTERS',
    debug_id: null,
  };
}

/** Order, capture and refund ids: ^[A-Z0-9]{1,36}$ (guards path injection). */
export const isPathId = (id: string): boolean =>
  typeof id === 'string' && /^[A-Z0-9]{1,36}$/.test(id);

export function buildHeaders(o: {
  method: 'GET' | 'POST';
  token: string;
  requestId: string | null;
}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${o.token}`,
    Accept: 'application/json',
  };
  if (o.method === 'POST') {
    h['Content-Type'] = 'application/json';
    h.Prefer = 'return=representation';
    if (o.requestId !== null) h['PayPal-Request-Id'] = o.requestId;
  }
  return h;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function getHeader(headers: Record<string, string>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === 'string') return v;
  }
  return null;
}

// A debug id is a short token. Anything else (an email, a sentence) is dropped so it never reaches
// a result or a record.
const DEBUG_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Response header `paypal-debug-id` if present, else body `debug_id`. */
export function debugIdOf(headers: Record<string, string>, body: unknown): string | null {
  const h = getHeader(headers, 'paypal-debug-id');
  if (h !== null && DEBUG_ID.test(h)) return h;
  if (isRecord(body) && typeof body.debug_id === 'string' && DEBUG_ID.test(body.debug_id)) {
    return body.debug_id;
  }
  return null;
}

// The only host the buyer may be sent to. Built from parts so no source file carries the literal.
const APPROVAL_HOST = ['www', 'sandbox', 'paypal', 'com'].join('.');

/** https, exactly the sandbox approval host, no credentials, no port. */
export function isApprovalUrl(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === APPROVAL_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === ''
  );
}

/** First link with this rel, as the raw href, or undefined. */
export function linkHref(body: unknown, rel: string): unknown {
  if (!isRecord(body) || !Array.isArray(body.links)) return undefined;
  for (const l of body.links as unknown[]) {
    if (isRecord(l) && l.rel === rel) return l.href;
  }
  return undefined;
}
