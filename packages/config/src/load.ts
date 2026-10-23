// The only file in the repository that may read process.env (lint S3). loadConfig itself takes a
// plain object, so tests never touch the real environment.
import { err, ok } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';
import type { BootRefusal } from './refusal';
import { BOOT_REFUSAL_EXIT_CODE, refusalLine } from './refusal';
import { makeSecret } from './secret';
import { KNOWN_CORRIDORS, MIN_SECRET_BYTES, isPublicOrigin } from './schema';
import type { Config, Mode } from './schema';

type Env = Record<string, string | undefined>;

// D-013: the sandbox base URL is a code constant in packages/transport and no environment variable
// may carry a PayPal host at all, sandbox or live. The pattern matches the registrable names only.
const PAYPAL_HOST = /paypal(?:objects)?\.com/i;
// Review 4 M1: look at the value the way a URL parser would. Same steps as scripts/check-no-live-host.mjs
// (config cannot import scripts, so this is a copy; config.test.ts holds the same cases):
// percent- and escape-decoding (repeated), NFKC (full-width letters and dots), other full stops mapped
// to '.', then the code points IDNA ignores are removed (soft hyphen, U+034F, zero-width, variation
// selectors, bidi and format controls).
const DOTS = /[\u3002\uFF61\uFE52\u2024\u2E2E]/gu;
const IGNORED_RANGES: [number, number][] = [
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe01ef],
];
// Not a regex character class: lint rejects combining marks and joiners inside one.
const stripIgnored = (t: string): string =>
  Array.from(t)
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return !IGNORED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
    })
    .join('');
const unescapeOnce = (t: string): string =>
  t
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, h: string) => String.fromCharCode(parseInt(h, 16)));
const percentOnce = (t: string): string => {
  try {
    return decodeURIComponent(t);
  } catch {
    return t.replace(/%([0-9a-fA-F]{2})/g, (m, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
};
export function foldHostText(v: string): string {
  let t = v;
  for (let i = 0; i < 3; i++) {
    const next = percentOnce(unescapeOnce(t));
    if (next === t) break;
    t = next;
  }
  return stripIgnored(t.normalize('NFKC').replace(DOTS, '.'));
}
const carriesPayPalHost = (v: string): boolean =>
  PAYPAL_HOST.test(v) || PAYPAL_HOST.test(foldHostText(v));
// Review 4 L8: long enough once trimmed, and not one character repeated.
const isWeakSecret = (v: string): boolean => {
  const t = v.trim();
  return Buffer.byteLength(t, 'utf8') < MIN_SECRET_BYTES || /^(.)\1*$/su.test(t);
};
const MODE_WORD = /(?:^|[^a-z0-9])(?:live|production)(?:$|[^a-z0-9])/i;

// F-1 (A-01): a variable whose NAME looks PayPal-related or live-related and is not on the known list
// is refused, so a deployer who sets PAYPAL_ENV=live or UMS_LIVE=1 gets a loud stop, not a silent ignore.
const KNOWN_PAYPAL_OR_MODE_NAMES: ReadonlySet<string> = new Set([
  'UMS_MODE',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_PAYPAL_CONNECT',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'NEXT_PUBLIC_UMS_ENV_LABEL',
]);
// Known names whose value is checked word-wise (the client secret is random text: never inspected).
const MODE_VALUE_NAMES: readonly string[] = [
  'UMS_OUTBOUND_APPROVAL_REF',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_WEBHOOK_ID',
];
const SUSPICIOUS_NAME = /paypal|(?:^|[^a-z0-9])(?:live|production)(?:$|[^a-z0-9])/i;
const suspiciousUnknownName = (name: string): boolean =>
  !KNOWN_PAYPAL_OR_MODE_NAMES.has(name) && SUSPICIOUS_NAME.test(name);

const refuse = (code: BootRefusal['code'], name: string) => err<BootRefusal>({ code, name });
const val = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

// FIX-BPREP M1. Variables that change where a connection goes or which certificates it trusts.
// Refused in sandbox mode only: a proxy or a replaced CA store would see the client secret.
const OVERRIDE_NAMES: ReadonlySet<string> = new Set([
  'NODE_USE_ENV_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  // FIX-MVPB-SEAL2 M3: more ways to change which certificates or OpenSSL settings a connection uses.
  'NODE_USE_SYSTEM_CA',
  'NODE_PRESERVE_SYMLINKS',
  'NODE_PATH',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
// Node flags that redirect or intercept the connection, replace the trust store or load code before
// the application (module hooks, loaders, preloads). Kept in step with the production Wire in
// packages/transport and the spike kit, which check the same list again on every request.
const OVERRIDE_FLAG =
  /^(?:--use-env-proxy|--require|-r|--import|--inspect(?:-brk|-wait|-port|-publish-uid)?|--loader|--experimental-loader|--use-system-ca|--use-openssl-ca|--openssl-config|--openssl-shared-config|--tls-keylog|--tls-min-v1\.[01]|--heapsnapshot-signal|--heapsnapshot-near-heap-limit|--experimental-network-inspection|--secure-heap(?:-min)?|--conditions|-C|--preserve-symlinks(?:-main)?|--experimental-(?:default-)?config-file|--insecure-http-parser|--report-[a-z-]+|--snapshot-blob|--build-snapshot)(?:=|$)/;
function transportOverride(env: Env, execArgv: readonly string[]): string | null {
  for (const [name, v] of Object.entries(env)) {
    const up = name.toUpperCase();
    if (OVERRIDE_NAMES.has(up) && v !== undefined && v.trim() !== '') return up;
  }
  return execArgv.some((a) => OVERRIDE_FLAG.test(a)) ? 'execArgv' : null;
}

export interface LoadOptions {
  /** process.execArgv of the booting process; omitted in tests that do not care. */
  execArgv?: readonly string[];
}

export function loadConfig(env: Env, opts: LoadOptions = {}): Result<Config, BootRefusal> {
  // 1. mode words and unknown modes
  const rawMode = val(env, 'UMS_MODE');
  let mode: Mode = 'offline';
  if (rawMode !== undefined) {
    const m = rawMode.toLowerCase();
    if (m === 'offline' || m === 'sandbox') mode = m;
    else if (MODE_WORD.test(m)) return refuse('live_not_available', 'UMS_MODE');
    else return refuse('unknown_mode', 'UMS_MODE');
  }
  if (mode === 'sandbox') {
    const o = transportOverride(env, opts.execArgv ?? []);
    if (o !== null) return refuse('transport_env_override', o);
  }
  const label = val(env, 'NEXT_PUBLIC_UMS_ENV_LABEL');
  if (label !== undefined && MODE_WORD.test(label)) {
    return refuse('live_not_available', 'NEXT_PUBLIC_UMS_ENV_LABEL');
  }
  // L3: the label is cosmetic, so a label that contradicts the mode would mislead a viewer. Offline
  // means Dry run only; sandbox means Sandbox only. Other words (a free label) are not judged.
  if (label !== undefined) {
    const norm = label.toLowerCase().replace(/[\s_-]+/g, ' ');
    if (norm === 'sandbox' && mode !== 'sandbox')
      return refuse('label_mode_mismatch', 'NEXT_PUBLIC_UMS_ENV_LABEL');
    if (norm === 'dry run' && mode !== 'offline')
      return refuse('label_mode_mismatch', 'NEXT_PUBLIC_UMS_ENV_LABEL');
  }

  // 2. any PayPal hostname in any environment variable value (D-013)
  for (const [name, v] of Object.entries(env)) {
    if (v !== undefined && carriesPayPalHost(v)) return refuse('non_sandbox_host', name);
  }

  // 1b. F-1: unknown PayPal- or live-looking names, and live/production words in known identifiers
  for (const [name, v] of Object.entries(env)) {
    if (v === undefined || v.trim() === '') continue;
    if (suspiciousUnknownName(name)) return refuse('live_not_available', name);
  }
  for (const name of MODE_VALUE_NAMES) {
    const v = val(env, name);
    if (v !== undefined && MODE_WORD.test(v)) return refuse('live_not_available', name);
  }

  // 3. connect flag
  const rawConnect = val(env, 'UMS_PAYPAL_CONNECT');
  if (rawConnect !== undefined && rawConnect !== 'on' && rawConnect !== 'off') {
    return refuse('missing_value', 'UMS_PAYPAL_CONNECT');
  }
  const connect = rawConnect === 'on';

  // 4. node env
  // Review 4 M2: any casing of a known value, nothing else. An unknown value must not fall back to
  // development, which would skip the production checks below.
  const ne = val(env, 'NODE_ENV')?.toLowerCase();
  if (ne !== undefined && ne !== 'development' && ne !== 'test' && ne !== 'production') {
    return refuse('missing_value', 'NODE_ENV');
  }
  const node_env: Config['node_env'] = ne ?? 'development';

  // 5. secrets: present, long enough, distinct
  const secretNames = ['UMS_SESSION_SECRET', 'UMS_APPROVAL_SECRET', 'UMS_LINK_SECRET'] as const;
  const secretValues: string[] = [];
  for (const name of secretNames) {
    const v = env[name];
    if (v === undefined || v === '') return refuse('missing_value', name);
    if (isWeakSecret(v)) return refuse('weak_secret', name);
    secretValues.push(v);
  }

  // 6. sandbox needs an approval ref and credentials, even with connect off
  const approvalRef = val(env, 'UMS_OUTBOUND_APPROVAL_REF') ?? null;
  let paypal: Config['paypal'] = null;
  if (mode === 'sandbox') {
    if (approvalRef === null) return refuse('missing_value', 'UMS_OUTBOUND_APPROVAL_REF');
    const id = val(env, 'PAYPAL_CLIENT_ID');
    if (id === undefined) return refuse('missing_value', 'PAYPAL_CLIENT_ID');
    const secret = val(env, 'PAYPAL_CLIENT_SECRET');
    if (secret === undefined) return refuse('missing_value', 'PAYPAL_CLIENT_SECRET');
    paypal = {
      client_id: makeSecret(id),
      client_secret: makeSecret(secret),
      webhook_id: val(env, 'PAYPAL_WEBHOOK_ID') ?? null,
    };
    if (id === secret) return refuse('equal_secrets', 'PAYPAL_CLIENT_SECRET');
    secretValues.push(secret);
  }
  if (new Set(secretValues).size !== secretValues.length) {
    return refuse('equal_secrets', 'UMS_SESSION_SECRET');
  }

  // 7. database target
  const dbKind = val(env, 'UMS_DB') ?? 'pglite-memory';
  let db: Config['db'];
  if (dbKind === 'pglite-memory') db = { kind: 'pglite-memory' };
  else if (dbKind === 'pglite-disk') {
    const dir = val(env, 'UMS_PGLITE_DIR');
    if (dir === undefined) return refuse('missing_value', 'UMS_PGLITE_DIR');
    db = { kind: 'pglite-disk', dir };
  } else if (dbKind === 'postgres') {
    const url = val(env, 'DATABASE_URL');
    if (url === undefined) return refuse('missing_value', 'DATABASE_URL');
    db = { kind: 'postgres', url: makeSecret(url) };
  } else return refuse('missing_value', 'UMS_DB');

  // 8. origin
  const origin = val(env, 'UMS_PUBLIC_ORIGIN');
  if (origin === undefined && node_env === 'production') {
    return refuse('missing_value', 'UMS_PUBLIC_ORIGIN');
  }
  const public_origin = origin ?? 'http://localhost:3000';
  if (!isPublicOrigin(public_origin)) return refuse('insecure_origin', 'UMS_PUBLIC_ORIGIN');

  // 9. passcode hash
  const passcode_hash = val(env, 'UMS_DEMO_PASSCODE_HASH') ?? null;
  if (node_env === 'production' && mode === 'offline' && passcode_hash === null) {
    return refuse('missing_value', 'UMS_DEMO_PASSCODE_HASH');
  }

  // 10. corridors
  const corridors = (val(env, 'UMS_CORRIDORS') ?? KNOWN_CORRIDORS[0] ?? '')
    .split(',')
    .map((c) => c.trim());
  if (corridors.length === 0 || corridors.some((c) => !KNOWN_CORRIDORS.includes(c))) {
    return refuse('unknown_corridor', 'UMS_CORRIDORS');
  }

  // 11. proxies in front of the app: an integer 0 to 3, nothing else (M3)
  const rawProxies = val(env, 'UMS_TRUSTED_PROXIES') ?? '0';
  if (!/^[0-3]$/.test(rawProxies)) return refuse('invalid_value', 'UMS_TRUSTED_PROXIES');
  const trusted_proxies = Number(rawProxies);

  return ok<Config>({
    mode,
    connect,
    outbound_approval_ref: approvalRef,
    paypal,
    db,
    session_secret: makeSecret(secretValues[0] ?? ''),
    approval_secret: makeSecret(secretValues[1] ?? ''),
    link_secret: makeSecret(secretValues[2] ?? ''),
    passcode_hash,
    public_origin,
    corridors,
    trusted_proxies,
    env_label: mode === 'sandbox' ? 'Sandbox' : 'Dry run',
    node_env,
  });
}

// Refuses to boot with exit code 78. The message names the variable and the rule, never a value.
export function bootOrExit(
  env: Env,
  exit: (code: number) => never,
  write: (line: string) => void,
): Config {
  const r = loadConfig(env, { execArgv: process.execArgv });
  if (!r.ok) {
    write(refusalLine(r.error));
    return exit(BOOT_REFUSAL_EXIT_CODE);
  }
  return r.value;
}

/** The terminal facts the operator CLIs check (SOP 2): only the CI flag, never a value that could be a secret. */
export function terminalEnv(): Record<string, string | undefined> {
  return { CI: process.env.CI };
}

/** The one place that hands the real environment to loadConfig. */
export function loadConfigFromProcess(): Result<Config, BootRefusal> {
  return loadConfig(process.env, { execArgv: process.execArgv });
}
