// Redaction by key (anywhere in nested data, case-insensitive) and by value pattern.
// Runs in the logger, in the audit sink and (later) in provider_calls and fixture recording.
// Adapted in spirit from the redaction design in docs/design/architecture.md section 9.9.
import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'access_token',
  'refresh_token',
  'client_secret',
  'client_id',
  'secret',
  'password',
  'passcode',
  'cookie',
  'set-cookie',
  'payer',
  'email_address',
  'email',
  'name',
  'given_name',
  'surname',
  'address',
  'phone',
  'payer_id',
  'paypal-transmission-sig',
]);

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const PAYPAL_TOKEN = /A21AA[A-Za-z0-9_-]{20,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function hashEmail(email: string): string {
  return `sha256:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

export function redactString(s: string): string {
  return s.replace(BEARER, REDACTED).replace(PAYPAL_TOKEN, REDACTED).replace(EMAIL, hashEmail);
}

function walk(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactString(value);
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
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : walk(v, ancestors);
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
