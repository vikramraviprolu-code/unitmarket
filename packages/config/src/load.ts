// The only file in the repository that may read process.env (lint S3). loadConfig itself takes a
// plain object, so tests never touch the real environment.
import { err, ok } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';
import { join, posix } from 'node:path';
import { parseEnv } from 'node:util';
import { defaultReadEnvFile } from './env-file';
import type { BootRefusal } from './refusal';
import { BOOT_REFUSAL_EXIT_CODE, refusalLine } from './refusal';
import { makeSecret } from './secret';
import {
  AI_ADAPTERS,
  KNOWN_CORRIDORS,
  LEARN_UNTIL_PATTERN,
  MAINTENANCE_FLAG_NAME,
  MAX_TOTP_OPERATORS,
  MERCHANT_ID_PATTERN,
  MIN_SECRET_BYTES,
  MIN_TOTP_KEY_BYTES,
  OFFER_MAX_MINOR_DEFAULT,
  OFFER_MAX_MINOR_LIMIT,
  OPERATOR_NAME_PATTERN,
  OUTBOUND_SCOPES,
  RESERVED_OPERATOR_NAME,
  isPublicOrigin,
} from './schema';
import type { AiAdapter, Config, Mode, OutboundScope } from './schema';

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
  'UMS_OUTBOUND_SCOPE',
  'UMS_OWN_MERCHANT_ID',
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
// BU-6c: scrypt:N:r:p:salt_hex:hash_hex (current) or the same with `$` (old), one separator
// throughout. config imports only contracts, so this repeats the shape of
// packages/security/src/passcode.ts; scripts/passcode-env-load.integration.test.ts pins the two.
const PASSCODE_HASH_SHAPE =
  /^scrypt(?::[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*:(?:[0-9a-f]{2}){16,64}:[0-9a-f]{64}|\$[1-9][0-9]*\$[1-9][0-9]*\$[1-9][0-9]*\$(?:[0-9a-f]{2}){16,64}\$[0-9a-f]{64})$/;

// CO-6 (ASM-56): UMS_OPERATOR_TOTP_KEYS = name:base32[,name:base32...]. Parsed once; the keys leave this
// function only as Secrets, upper case and unpadded. Nothing about a bad value is reported but the
// variable name. packages/security decodes the same text again with its own base32 reader, and
// apps/web/src/operator-mfa.integration.test.ts pins that the two agree.
const BASE32_BODY = /^[A-Z2-7]+$/;
const PAD_FOR_REMAINDER: Record<number, number> = { 0: 0, 2: 6, 4: 4, 5: 3, 7: 1 };
function parseOperatorTotpKeys(
  raw: string | undefined,
): Result<Config['operator_totp_keys'], BootRefusal> {
  const name = 'UMS_OPERATOR_TOTP_KEYS';
  if (raw === undefined) return ok([]);
  const entries = raw.split(',');
  if (entries.length > MAX_TOTP_OPERATORS) return refuse('invalid_value', name);
  const out: Array<{ name: string; key: ReturnType<typeof makeSecret> }> = [];
  const seenNames = new Set<string>();
  const seenKeys = new Set<string>();
  let tooShort = false;
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon < 0) return refuse('invalid_value', name);
    const who = entry.slice(0, colon).trim();
    const text = entry.slice(colon + 1).trim();
    if (!OPERATOR_NAME_PATTERN.test(who) || who === RESERVED_OPERATOR_NAME)
      return refuse('invalid_value', name);
    const m = /^([A-Za-z2-7]+)(={0,6})$/.exec(text);
    if (m === null) return refuse('invalid_value', name);
    const body = (m[1] ?? '').toUpperCase();
    const pad = (m[2] ?? '').length;
    const wantPad = PAD_FOR_REMAINDER[body.length % 8];
    if (wantPad === undefined || (pad !== 0 && pad !== wantPad) || !BASE32_BODY.test(body))
      return refuse('invalid_value', name);
    if (seenNames.has(who) || seenKeys.has(body)) return refuse('invalid_value', name);
    seenNames.add(who);
    seenKeys.add(body);
    // Short or degenerate keys are reported after the whole value has been checked for shape.
    if (Math.floor((body.length * 5) / 8) < MIN_TOTP_KEY_BYTES || /^(.)\1*$/s.test(body))
      tooShort = true;
    out.push({ name: who, key: makeSecret(body) });
  }
  return tooShort ? refuse('weak_secret', name) : ok(out);
}

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
  // BU-6c: a value a dotenv loader mangled (`scrypt6384`) must stop the boot, not turn into a silent
  // sign-in failure. Shape only; @umsbx/security checks the work factors. Names the variable only.
  if (passcode_hash !== null && !PASSCODE_HASH_SHAPE.test(passcode_hash)) {
    return refuse('invalid_value', 'UMS_DEMO_PASSCODE_HASH');
  }
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

  // 12. the approval scope the app serves: a known value, nothing else (an unknown value must not
  // fall back to something wider)
  const rawScope = val(env, 'UMS_OUTBOUND_SCOPE') ?? 'mvp_b_polling';
  if (!(OUTBOUND_SCOPES as readonly string[]).includes(rawScope))
    return refuse('invalid_value', 'UMS_OUTBOUND_SCOPE');
  const outbound_scope = rawScope as OutboundScope;

  // 13. our own merchant id (D-028): optional, non-secret, exact charset. The error names the
  // variable, never the value.
  const rawOwn = val(env, 'UMS_OWN_MERCHANT_ID') ?? null;
  if (rawOwn !== null && !MERCHANT_ID_PATTERN.test(rawOwn))
    return refuse('invalid_value', 'UMS_OWN_MERCHANT_ID');

  // 14. operator TOTP keys (CO-6): optional; a bad value stops the boot, naming the variable only.
  const totp = parseOperatorTotpKeys(val(env, 'UMS_OPERATOR_TOTP_KEYS'));
  if (!totp.ok) return err<BootRefusal>(totp.error);

  // 15. the webhook certificate learn window (CO-1d, D-038): optional, sandbox mode only, a strict UTC
  // time. A time in the past is accepted (the window is then closed); the 24 h cap needs a clock and is
  // checked by composition. The error names the variable, never the value.
  const rawLearn = val(env, 'UMS_WEBHOOK_CERT_LEARN_UNTIL') ?? null;
  let webhook_cert_learn_until: string | null = null;
  if (rawLearn !== null) {
    if (mode !== 'sandbox' || !LEARN_UNTIL_PATTERN.test(rawLearn))
      return refuse('invalid_value', 'UMS_WEBHOOK_CERT_LEARN_UNTIL');
    const at = new Date(rawLearn);
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== rawLearn.slice(0, 19))
      return refuse('invalid_value', 'UMS_WEBHOOK_CERT_LEARN_UNTIL');
    webhook_cert_learn_until = at.toISOString();
  }

  // 16. the maintenance flag path (CO-7b, D-037): optional; the value is read as written (no trimming),
  // an absolute normal path named ums-maintenance. With a PGlite folder on disk it must sit beside that
  // folder, never inside it (a restore replaces the folder, and the flag must survive that). The error
  // names the variable, never the value.
  const rawFlag = env['UMS_MAINTENANCE_FLAG'];
  let maintenance_flag: string | null = null;
  if (rawFlag !== undefined && rawFlag.trim() !== '') {
    const normal =
      /^\/[\x21-\x7E]+$/.test(rawFlag) &&
      posix.normalize(rawFlag) === rawFlag &&
      posix.basename(rawFlag) === MAINTENANCE_FLAG_NAME &&
      !rawFlag.endsWith('/');
    const beside =
      db.kind !== 'pglite-disk' || posix.dirname(rawFlag) === posix.dirname(posix.resolve(db.dir));
    if (!normal || !beside) return refuse('invalid_value', 'UMS_MAINTENANCE_FLAG');
    maintenance_flag = rawFlag;
  }

  // 17. the publisher passcode hash (CFG-0, D-065 item 34): optional, same shape as the demo hash, and
  // never equal to it (a separate hash is the point). Equality ignores the separator form, so the `:` and
  // `$` spellings of one hash count as equal. The error names the variable, never the value.
  const publisher_passcode_hash = val(env, 'UMS_PUBLISHER_PASSCODE_HASH') ?? null;
  if (publisher_passcode_hash !== null) {
    if (!PASSCODE_HASH_SHAPE.test(publisher_passcode_hash))
      return refuse('invalid_value', 'UMS_PUBLISHER_PASSCODE_HASH');
    if (
      passcode_hash !== null &&
      passcode_hash.replaceAll('$', ':') === publisher_passcode_hash.replaceAll('$', ':')
    )
      return refuse('equal_secrets', 'UMS_PUBLISHER_PASSCODE_HASH');
  }

  // 17b. the judge passcode hash (JUDGE-A): optional, same shape as the demo hash, never equal to the demo
  // hash or the publisher hash (three separate hashes are the point). Equality ignores the separator form.
  // The error names the variable, never the value.
  const judge_passcode_hash = val(env, 'UMS_JUDGE_PASSCODE_HASH') ?? null;
  if (judge_passcode_hash !== null) {
    if (!PASSCODE_HASH_SHAPE.test(judge_passcode_hash))
      return refuse('invalid_value', 'UMS_JUDGE_PASSCODE_HASH');
    const same = (other: string | null): boolean =>
      other !== null && other.replaceAll('$', ':') === judge_passcode_hash.replaceAll('$', ':');
    if (same(passcode_hash) || same(publisher_passcode_hash))
      return refuse('equal_secrets', 'UMS_JUDGE_PASSCODE_HASH');
  }

  // 18. the largest offer price in minor units (CFG-0, D-065 item 35): a plain integer 1 to 2000.
  const rawOfferMax = val(env, 'UMS_OFFER_MAX_MINOR');
  let offer_max_minor = OFFER_MAX_MINOR_DEFAULT;
  if (rawOfferMax !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(rawOfferMax))
      return refuse('invalid_value', 'UMS_OFFER_MAX_MINOR');
    offer_max_minor = Number(rawOfferMax);
    if (offer_max_minor > OFFER_MAX_MINOR_LIMIT)
      return refuse('invalid_value', 'UMS_OFFER_MAX_MINOR');
  }

  // 19. the model adapter and its key (CFG-0): an exact known value; the key is read only for claude and
  // is then required. The name is UMS_ANTHROPIC_API_KEY on purpose; ANTHROPIC_API_KEY is never read.
  const rawAdapter = val(env, 'UMS_AI_ADAPTER') ?? 'scripted';
  if (!(AI_ADAPTERS as readonly string[]).includes(rawAdapter))
    return refuse('invalid_value', 'UMS_AI_ADAPTER');
  const ai_adapter = rawAdapter as AiAdapter;
  let ai_api_key: Config['ai_api_key'] = null;
  if (ai_adapter === 'claude') {
    const key = val(env, 'UMS_ANTHROPIC_API_KEY');
    if (key === undefined) return refuse('missing_value', 'UMS_ANTHROPIC_API_KEY');
    ai_api_key = makeSecret(key);
  }

  return ok<Config>({
    mode,
    connect,
    outbound_approval_ref: approvalRef,
    outbound_scope,
    own_merchant_id: rawOwn,
    paypal,
    db,
    session_secret: makeSecret(secretValues[0] ?? ''),
    approval_secret: makeSecret(secretValues[1] ?? ''),
    link_secret: makeSecret(secretValues[2] ?? ''),
    passcode_hash,
    publisher_passcode_hash,
    judge_passcode_hash,
    offer_max_minor,
    ai_adapter,
    ai_api_key,
    operator_totp_keys: totp.value,
    webhook_cert_learn_until,
    public_origin,
    corridors,
    trusted_proxies,
    maintenance_flag,
    env_label: mode === 'sandbox' ? 'Sandbox' : 'Dry run',
    node_env,
  });
}

// F8 (D-059): Node's --env-file-if-exists and Next never replace a value the process already holds, so a
// terminal that still exports DATABASE_URL, UMS_DB or UMS_PAYPAL_CONNECT silently beats .env.local.
// The names below are compared with the file; every other name, every secret included, never is.
const GUARDED_NAMES: readonly string[] = [
  'UMS_MODE',
  'UMS_PAYPAL_CONNECT',
  'UMS_DB',
  'UMS_PGLITE_DIR',
  'DATABASE_URL',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_OUTBOUND_SCOPE',
  'UMS_OWN_MERCHANT_ID',
  'UMS_PUBLIC_ORIGIN',
];

/** Reads a file as text; null when it does not exist. */
export type EnvFileReader = (path: string) => string | null;

/**
 * The first guarded name for which the process holds a value and the file holds a different one or none.
 * A name the process does not hold is skipped (the file was not loaded, as in tests). Returns the name,
 * never a value. Parsed with util.parseEnv, the parser behind --env-file.
 */
export function findEnvOverride(env: Env, fileText: string): string | null {
  const file = parseEnv(fileText);
  for (const name of GUARDED_NAMES) {
    const held = env[name];
    if (held === undefined) continue;
    if (file[name] !== held) return name;
  }
  return null;
}

function envFileRefusal(env: Env, read: EnvFileReader): BootRefusal | null {
  const text = read(join(process.cwd(), '.env.local'));
  if (text === null) return null;
  const name = findEnvOverride(env, text);
  return name === null ? null : { code: 'env_overrides_file', name };
}

// Refuses to boot with exit code 78. The message names the variable and the rule, never a value.
// With readEnvFile the env is also checked against .env.local first (loadConfigFromProcess does the same).
export function bootOrExit(
  env: Env,
  exit: (code: number) => never,
  write: (line: string) => void,
  readEnvFile?: EnvFileReader,
): Config {
  const overridden = readEnvFile === undefined ? null : envFileRefusal(env, readEnvFile);
  if (overridden !== null) {
    write(refusalLine(overridden));
    return exit(BOOT_REFUSAL_EXIT_CODE);
  }
  const r = loadConfig(env, { execArgv: process.execArgv });
  if (!r.ok) {
    write(refusalLine(r.error));
    return exit(BOOT_REFUSAL_EXIT_CODE);
  }
  return r.value;
}

/**
 * The terminal facts the operator CLIs check (SOP 2): the CI flags and the AI-session markers, never a
 * value that could be a secret. safety:approve and safety:stop read CI; safety:resume (BU-2) reads all.
 */
export function terminalEnv(): Record<string, string | undefined> {
  return {
    CI: process.env.CI,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    CLAUDECODE: process.env.CLAUDECODE,
    CLAUDE_CODE_REMOTE: process.env.CLAUDE_CODE_REMOTE,
    AI_AGENT: process.env.AI_AGENT,
    CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
  };
}

export interface ProcessLoadOptions {
  /** Reads .env.local; the default reads the file with fs and gives null when it is missing. */
  readEnvFile?: EnvFileReader;
}

/**
 * The one place that hands the real environment to loadConfig. A .env.local in the current folder that
 * the process environment overrides (see findEnvOverride) is refused before loadConfig runs.
 */
export function loadConfigFromProcess(opts: ProcessLoadOptions = {}): Result<Config, BootRefusal> {
  const overridden = envFileRefusal(process.env, opts.readEnvFile ?? defaultReadEnvFile);
  if (overridden !== null) return err<BootRefusal>(overridden);
  return loadConfig(process.env, { execArgv: process.execArgv });
}
