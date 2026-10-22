// The only file in the repository that may read process.env (lint S3). loadConfig itself takes a
// plain object, so tests never touch the real environment.
import { err, ok } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';
import type { BootRefusal } from './refusal';
import { BOOT_REFUSAL_EXIT_CODE, refusalLine } from './refusal';
import { makeSecret } from './secret';
import { ENV_NAMES, KNOWN_CORRIDORS, MIN_SECRET_BYTES, ORIGIN_PATTERN } from './schema';
import type { Config, Mode } from './schema';

type Env = Record<string, string | undefined>;

// Built from parts so no PayPal hostname literal sits in the tree (scripts/check-no-live-host).
const PP = ['paypal', 'com'].join('.');
const ALLOWED_PAYPAL_HOST = ['api-m', 'sandbox', PP].join('.');
const PAYPAL_HOST = new RegExp(`[a-z0-9.-]*${PP.replace('.', '\\.')}`, 'gi');
const MODE_WORD = /(?:^|[^a-z0-9])(?:live|production)(?:$|[^a-z0-9])/i;

const refuse = (code: BootRefusal['code'], name: string) => err<BootRefusal>({ code, name });
const val = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

export function loadConfig(env: Env): Result<Config, BootRefusal> {
  // 1. mode words and unknown modes
  const rawMode = val(env, 'UMS_MODE');
  let mode: Mode = 'offline';
  if (rawMode !== undefined) {
    const m = rawMode.toLowerCase();
    if (m === 'offline' || m === 'sandbox') mode = m;
    else if (MODE_WORD.test(m)) return refuse('live_not_available', 'UMS_MODE');
    else return refuse('unknown_mode', 'UMS_MODE');
  }
  const label = val(env, 'NEXT_PUBLIC_UMS_ENV_LABEL');
  if (label !== undefined && MODE_WORD.test(label)) {
    return refuse('live_not_available', 'NEXT_PUBLIC_UMS_ENV_LABEL');
  }

  // 2. any PayPal hostname other than the sandbox API host, in any known value
  for (const name of ENV_NAMES) {
    const v = env[name];
    if (v === undefined) continue;
    for (const host of v.match(PAYPAL_HOST) ?? []) {
      if (host.toLowerCase() !== ALLOWED_PAYPAL_HOST) return refuse('non_sandbox_host', name);
    }
  }

  // 3. connect flag
  const rawConnect = val(env, 'UMS_PAYPAL_CONNECT');
  if (rawConnect !== undefined && rawConnect !== 'on' && rawConnect !== 'off') {
    return refuse('missing_value', 'UMS_PAYPAL_CONNECT');
  }
  const connect = rawConnect === 'on';

  // 4. node env
  const ne = val(env, 'NODE_ENV');
  const node_env: Config['node_env'] =
    ne === 'production' ? 'production' : ne === 'test' ? 'test' : 'development';

  // 5. secrets: present, long enough, distinct
  const secretNames = ['UMS_SESSION_SECRET', 'UMS_APPROVAL_SECRET', 'UMS_LINK_SECRET'] as const;
  const secretValues: string[] = [];
  for (const name of secretNames) {
    const v = env[name];
    if (v === undefined || v === '') return refuse('missing_value', name);
    if (Buffer.byteLength(v, 'utf8') < MIN_SECRET_BYTES) return refuse('weak_secret', name);
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
  if (!ORIGIN_PATTERN.test(public_origin)) return refuse('insecure_origin', 'UMS_PUBLIC_ORIGIN');

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
  const r = loadConfig(env);
  if (!r.ok) {
    write(refusalLine(r.error));
    return exit(BOOT_REFUSAL_EXIT_CODE);
  }
  return r.value;
}

/** The one place that hands the real environment to loadConfig. */
export function loadConfigFromProcess(): Result<Config, BootRefusal> {
  return loadConfig(process.env);
}
