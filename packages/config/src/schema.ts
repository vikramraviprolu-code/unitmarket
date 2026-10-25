import type { Secret } from '@umsbx/contracts';

export type Mode = 'offline' | 'sandbox';

/** The approval scope the app serves (ASM-51): the MVP-B polling phase, or the later refunds phase. */
export type OutboundScope = 'mvp_b_polling' | 'mvp_c_refunds';
export const OUTBOUND_SCOPES: readonly OutboundScope[] = ['mvp_b_polling', 'mvp_c_refunds'];

export interface Config {
  mode: Mode;
  connect: boolean;
  outbound_approval_ref: string | null;
  /** UMS_OUTBOUND_SCOPE, default mvp_b_polling. Moving to mvp_c_refunds needs a new approval ref. */
  outbound_scope: OutboundScope;
  /**
   * UMS_OWN_MERCHANT_ID (BU-7, D-028): our own sandbox merchant id. Not a secret. When a create unit's
   * payee equals it exactly, the adapter leaves the payee out of the body. Null: never left out.
   */
  own_merchant_id: string | null;
  paypal: { client_id: Secret; client_secret: Secret; webhook_id: string | null } | null; // null in offline
  db:
    | { kind: 'pglite-memory' }
    | { kind: 'pglite-disk'; dir: string }
    | { kind: 'postgres'; url: Secret };
  session_secret: Secret;
  approval_secret: Secret;
  link_secret: Secret;
  passcode_hash: string | null;
  /**
   * UMS_OPERATOR_TOTP_KEYS (CO-6, ASM-56): one base32 TOTP key per operator, as Secrets (upper case, no
   * padding). Empty when unset: operators then sign in without a second factor (mfa false).
   */
  operator_totp_keys: ReadonlyArray<{ name: string; key: Secret }>;
  /**
   * UMS_WEBHOOK_CERT_LEARN_UNTIL (CO-1d, D-038): the end of the webhook certificate learn window, as an
   * ISO time, or null (no window). Sandbox mode only. Config only parses it: the window is open while the
   * injected clock is before this time, and composition refuses a time more than 24 h after boot
   * (webhookLearnWindow). While open the webhook route records certificate facts and acts on nothing.
   */
  webhook_cert_learn_until: string | null;
  public_origin: string;
  corridors: string[];
  /** Reverse proxies in front of the app, 0 to 3 (UMS_TRUSTED_PROXIES). 0: X-Forwarded-For is never read. */
  trusted_proxies: number;
  env_label: 'Dry run' | 'Sandbox';
  node_env: 'development' | 'test' | 'production';
}

/** Every variable this package reads (.env.example, exact), plus NODE_ENV. */
export const ENV_NAMES = [
  'UMS_MODE',
  'UMS_PAYPAL_CONNECT',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_OUTBOUND_SCOPE',
  'UMS_OWN_MERCHANT_ID',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'UMS_DB',
  'UMS_PGLITE_DIR',
  'DATABASE_URL',
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
  'UMS_OPERATOR_TOTP_KEYS',
  'UMS_WEBHOOK_CERT_LEARN_UNTIL',
  'UMS_PUBLIC_ORIGIN',
  'UMS_CORRIDORS',
  'UMS_TRUSTED_PROXIES',
  'NEXT_PUBLIC_UMS_ENV_LABEL',
] as const;

/** Corridor ids this build knows (architecture 12: one corridor at MVP). */
export const KNOWN_CORRIDORS: readonly string[] = ['us-usd'];

export const MIN_SECRET_BYTES = 32;

/** Operator TOTP keys (CO-6): at least 20 bytes (RFC 4226 section 4), a handful of operators. */
export const MIN_TOTP_KEY_BYTES = 20;
export const MAX_TOTP_OPERATORS = 8;
/** Same shape as OPERATOR_NAME in packages/security/src/totp.ts, which this package may not import; the web integration test pins the two. */
export const OPERATOR_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** The id `opr_demo` belongs to an operator session without a second factor, so no key may use the name. */
export const RESERVED_OPERATOR_NAME = 'demo';

/** The learn window (CO-1d, D-038) may end at most this long after the app boots. */
export const MAX_LEARN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A UTC time, seconds precision (milliseconds only as exactly three digits). No zone offsets, no dates alone. */
export const LEARN_UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Where the learn window stands at `now` (the caller's injected clock; config never reads time).
 * 'open' only while now < until <= now + 24 h. 'closed': no window, the end has passed (the end moment
 * itself is closed) or the value cannot be read. 'too_far': the end is more than 24 h away, which
 * composition refuses at boot.
 */
export function webhookLearnWindow(until: string | null, now: Date): 'closed' | 'open' | 'too_far' {
  if (until === null || !LEARN_UNTIL_PATTERN.test(until)) return 'closed';
  const end = Date.parse(until);
  const t = now.getTime();
  if (Number.isNaN(end) || Number.isNaN(t)) return 'closed';
  if (end > t + MAX_LEARN_WINDOW_MS) return 'too_far';
  return t < end ? 'open' : 'closed';
}

/** PayPal merchant ids are 13 characters, upper-case letters and digits (BU-7). Exact, no folding. */
export const MERCHANT_ID_PATTERN = /^[A-Z0-9]{13}$/;

// An origin is scheme://host[:port] with nothing else: https, or http on localhost. The value must
// equal what URL parsing reads back as its origin, so userinfo (https://x@localhost), a path, a
// query, a fragment, a trailing slash, backslashes and whitespace are all refused (review 4 M3).
export function isPublicOrigin(value: string): boolean {
  if (/[\s\\]/u.test(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.origin !== value || u.hostname === '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && u.hostname === 'localhost';
}
