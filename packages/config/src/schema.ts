import type { Secret } from '@umsbx/contracts';

export type Mode = 'offline' | 'sandbox';

export interface Config {
  mode: Mode;
  connect: boolean;
  outbound_approval_ref: string | null;
  paypal: { client_id: Secret; client_secret: Secret; webhook_id: string | null } | null; // null in offline
  db:
    | { kind: 'pglite-memory' }
    | { kind: 'pglite-disk'; dir: string }
    | { kind: 'postgres'; url: Secret };
  session_secret: Secret;
  approval_secret: Secret;
  link_secret: Secret;
  passcode_hash: string | null;
  public_origin: string;
  corridors: string[];
  env_label: 'Dry run' | 'Sandbox';
  node_env: 'development' | 'test' | 'production';
}

/** Every variable this package reads (.env.example, exact), plus NODE_ENV. */
export const ENV_NAMES = [
  'UMS_MODE',
  'UMS_PAYPAL_CONNECT',
  'UMS_OUTBOUND_APPROVAL_REF',
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
  'UMS_PUBLIC_ORIGIN',
  'UMS_CORRIDORS',
  'NEXT_PUBLIC_UMS_ENV_LABEL',
] as const;

/** Corridor ids this build knows (architecture 12: one corridor at MVP). */
export const KNOWN_CORRIDORS: readonly string[] = ['us-usd'];

export const MIN_SECRET_BYTES = 32;

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
