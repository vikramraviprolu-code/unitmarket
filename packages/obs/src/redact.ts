// Redaction by key (anywhere in nested data, normalised and substring matched), by value pattern
// and inside JSON-encoded strings.
// Runs in the logger, in the audit sink and (later) in provider_calls and fixture recording.
// Adapted in spirit from the redaction design in docs/design/architecture.md section 9.9.
import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';

// Keys are normalised (lowercase, with '-', '_', '.' and spaces removed) before matching, so
// clientSecret, CLIENT_SECRET and client-secret are one key. A key is redacted when its normalised
// form is in EXACT_KEYS or contains one of the SUBSTRINGS (M5).
const EXACT_KEYS: ReadonlySet<string> = new Set([
  'clientid',
  'cookie',
  'setcookie',
  'passcode',
  'payer',
  'payerid',
  'email',
  'emailaddress',
  'name',
  'fullname',
  'givenname',
  'surname',
  'address',
  'addressline1',
  'addressline2',
  'adminarea1',
  'adminarea2',
  'postalcode',
  'shipping',
  'phone',
  'phonenumber',
  'paypaltransmissionsig',
]);
const SUBSTRINGS: readonly string[] = ['secret', 'token', 'password', 'assertion', 'authorization'];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_.\s]/g, '');
  return EXACT_KEYS.has(k) || SUBSTRINGS.some((part) => k.includes(part));
}

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// An Authorization header or assignment: the whole value goes, whatever its scheme.
const AUTH_VALUE = /\bauthorization\s*[:=]\s*(?:basic|bearer|digest)?\s*[^\s,;"']+/gi;
// Bare "Basic <base64>": needs 8+ base64 characters with a digit, '+' or '/' so ordinary words
// ("basic information") are kept.
const BASIC = /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{8,}={0,2}/gi;
// Form-encoded or query-string secrets: client_secret=..., access_token=...
const SECRET_PAIR =
  /\b([A-Za-z0-9_-]*(?:secret|token|password|assertion)[A-Za-z0-9_-]*)=[^&\s"']+/gi;
const PAYPAL_TOKEN = /A21AA[A-Za-z0-9_-]{20,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function hashEmail(email: string): string {
  return `sha256:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

export function redactString(s: string): string {
  return s
    .replace(AUTH_VALUE, REDACTED)
    .replace(BEARER, REDACTED)
    .replace(BASIC, REDACTED)
    .replace(SECRET_PAIR, `$1=${REDACTED}`)
    .replace(PAYPAL_TOKEN, REDACTED)
    .replace(EMAIL, hashEmail);
}

const MAX_JSON_STRING = 1_000_000;

// A string that holds a JSON object or array (a request or response body) is parsed, redacted by
// key like any other value and written back as JSON. Anything else goes through the patterns only.
function redactStringValue(s: string, ancestors: Set<object>): string {
  const t = s.trimStart();
  if ((t.startsWith('{') || t.startsWith('[')) && s.length <= MAX_JSON_STRING) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed !== null && typeof parsed === 'object') {
        return JSON.stringify(walk(parsed, ancestors));
      }
    } catch {
      // not JSON: fall through to the pattern pass
    }
  }
  return redactString(s);
}

function walk(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactStringValue(value, ancestors);
  if (value === null || typeof value !== 'object') {
    // numbers, booleans, undefined; functions and symbols are never logged
    return typeof value === 'function' || typeof value === 'symbol' ? REDACTED : value;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return '[binary]';
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (value instanceof Error) return redactString(value.message);
    if (Array.isArray(value)) return value.map((v) => walk(v, ancestors));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : walk(v, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

// Returns a redacted copy; the input is never mutated.
export function redact(value: unknown): unknown {
  return walk(value, new Set());
}
