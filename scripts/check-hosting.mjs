// Fails when render.yaml (the hosting blueprint) holds an unsafe setting. CO-7.
//
// render.yaml carries env variable NAMES and safe non-secret values only. This guard parses the
// fixed subset of YAML the blueprint uses (no dependency; anything outside the subset is a parse
// failure, never a guess) and reports every violation by rule name. Values are never printed.
//
// Rules: parse, duplicate-key, service-shape, unknown-name, secret-with-value, live-value,
// paypal-host, public-name, instances, disk, pglite-dir, node-options, proxy-var, auto-deploy,
// telemetry, fixed-value.
//
// Usage: node scripts/check-hosting.mjs [--root <dir>]   (reads <root>/render.yaml)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoot } from './lib/walk.mjs';

const ROOT = resolveRoot(process.argv, import.meta.url);

// ---- names -------------------------------------------------------------------------------------
// Names packages/config reads, plus the two MVP-B/C names its sibling lanes add (UMS_OUTBOUND_SCOPE,
// UMS_OPERATOR_TOTP_KEYS), plus the three platform names Render or Next.js need. DATABASE_URL is
// left out on purpose: this blueprint runs PGlite on the disk and a database URL is a secret.
const EXTRA_NAMES = ['NODE_VERSION', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED'];
const CONFIG_NAMES = [
  'UMS_MODE',
  'UMS_PAYPAL_CONNECT',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_OUTBOUND_SCOPE',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'UMS_DB',
  'UMS_PGLITE_DIR',
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
  'UMS_OPERATOR_TOTP_KEYS',
  'UMS_PUBLIC_ORIGIN',
  'UMS_CORRIDORS',
  'UMS_TRUSTED_PROXIES',
  'NEXT_PUBLIC_UMS_ENV_LABEL',
];
const ALLOWED = new Set([...CONFIG_NAMES, ...EXTRA_NAMES]);
// Secret or owner-chosen: `sync: false`, no value.
const SECRETS = new Set([
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
  'UMS_OPERATOR_TOTP_KEYS',
  'UMS_PUBLIC_ORIGIN',
]);
// Fixed, non-secret values the blueprint must carry exactly.
const FIXED = {
  NODE_VERSION: '22.22.0',
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  UMS_MODE: 'sandbox',
  UMS_PAYPAL_CONNECT: 'off',
  UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
  UMS_DB: 'pglite-disk',
  UMS_PGLITE_DIR: '/var/data/pglite',
  UMS_TRUSTED_PROXIES: '1',
  NEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox',
};
const PROXY_VARS = /^(?:HTTP|HTTPS|ALL|NO|FTP)_PROXY$/i;
const LIVE_WORD = /live/i;
const PAYPAL_HOST = /paypal(?:objects)?\.com/i;
const MOUNT = '/var/data';
const BUILD =
  'corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm --filter @umsbx/web build';
const START = 'corepack pnpm --filter @umsbx/web start';

// ---- strict YAML subset ------------------------------------------------------------------------
class ParseError extends Error {}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw, lineNo) {
  const t = raw.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    if (t.length < 2 || t[t.length - 1] !== q || t.slice(1, -1).includes(q))
      throw new ParseError(`line ${lineNo}: unsupported quoted scalar`);
    if (q === '"' && t.includes('\\')) throw new ParseError(`line ${lineNo}: escapes unsupported`);
    return { v: t.slice(1, -1), quoted: true };
  }
  if (/^[[{|>&*!%@`]/.test(t)) throw new ParseError(`line ${lineNo}: unsupported YAML syntax`);
  if (/^(?:on|off|yes|no|y|n|null|~)$/i.test(t))
    throw new ParseError(`line ${lineNo}: ambiguous bare word; quote it`);
  if (t === 'true') return { v: true };
  if (t === 'false') return { v: false };
  if (/^-?\d+$/.test(t)) return { v: Number(t), num: t };
  return { v: t };
}

/** Parse the subset: block maps, block lists of maps or scalars, plain/quoted scalars, comments. */
function parseYaml(text) {
  const items = [];
  text.split('\n').forEach((rawLine, i) => {
    const no = i + 1;
    if (/\t/.test(rawLine.match(/^\s*/)[0])) throw new ParseError(`line ${no}: tab indentation`);
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (line.trim() === '') return;
    items.push({ indent: line.match(/^ */)[0].length, text: line.trim(), no });
  });
  let pos = 0;
  const dups = [];

  function block(indent) {
    if (pos >= items.length || items[pos].indent !== indent)
      throw new ParseError(`line ${items[pos]?.no ?? '?'}: bad indentation`);
    return items[pos].text.startsWith('- ') || items[pos].text === '-' ? list(indent) : map(indent);
  }

  function list(indent) {
    const out = [];
    while (pos < items.length && items[pos].indent === indent && items[pos].text.startsWith('-')) {
      const it = items[pos];
      const rest = it.text === '-' ? '' : it.text.slice(2);
      if (rest === '') throw new ParseError(`line ${it.no}: empty list item`);
      if (/^[^\s"'][^"']*?:(?:\s|$)/.test(rest) || /^["'].*["']:(?:\s|$)/.test(rest)) {
        // "- key: value" opens a map whose later keys sit two columns right of the dash.
        items[pos] = { indent: indent + 2, text: rest, no: it.no };
        out.push(map(indent + 2));
      } else {
        out.push(scalar(rest, it.no).v);
        pos++;
      }
    }
    return out;
  }

  function map(indent) {
    const out = {};
    while (
      pos < items.length &&
      items[pos].indent === indent &&
      !items[pos].text.startsWith('- ')
    ) {
      const it = items[pos];
      const m = it.text.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/);
      if (!m) throw new ParseError(`line ${it.no}: expected "key: value"`);
      const [, key, rest] = m;
      if (Object.hasOwn(out, key)) dups.push(key);
      pos++;
      if (rest === undefined || rest === '') {
        if (pos < items.length && items[pos].indent > indent) out[key] = block(items[pos].indent);
        else out[key] = null;
      } else {
        const s = scalar(rest, it.no);
        out[key] = s.v;
      }
    }
    return out;
  }

  if (items.length === 0) throw new ParseError('empty file');
  const root = block(items[0].indent);
  if (pos !== items.length) throw new ParseError(`line ${items[pos].no}: unexpected content`);
  return { root, dups };
}

// ---- rules -------------------------------------------------------------------------------------
const violations = [];
const fail = (rule, where) => violations.push({ rule, where });
const isMap = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => (typeof x === 'string' ? x : x === undefined ? undefined : String(x));

function checkService(svc) {
  if (!isMap(svc)) return fail('service-shape', 'service is not a map');
  const allowedKeys = new Set([
    'type',
    'name',
    'runtime',
    'plan',
    'numInstances',
    'autoDeploy',
    'buildCommand',
    'startCommand',
    'healthCheckPath',
    'disk',
    'envVars',
  ]);
  for (const k of Object.keys(svc))
    if (!allowedKeys.has(k)) fail('service-shape', `service key ${k} is not in the reviewed set`);
  if (svc.type !== 'web') fail('service-shape', 'type must be web');
  if (svc.runtime !== 'node') fail('service-shape', 'runtime must be node');
  if (typeof svc.plan !== 'string' || svc.plan === '' || svc.plan.toLowerCase() === 'free')
    fail('service-shape', 'plan must be a paid plan (free has no disk and sleeps)');
  if (svc.healthCheckPath !== '/healthz') fail('service-shape', 'healthCheckPath must be /healthz');
  if (svc.buildCommand !== BUILD)
    fail('service-shape', 'buildCommand differs from the reviewed one');
  if (svc.startCommand !== START)
    fail('service-shape', 'startCommand differs from the reviewed one');

  if (svc.numInstances !== 1) fail('instances', 'numInstances must be exactly 1');
  if (svc.autoDeploy !== false) fail('auto-deploy', 'autoDeploy must be explicitly false');

  // disk
  const disk = svc.disk;
  let mount = null;
  if (!isMap(disk)) fail('disk', 'a persistent disk is required');
  else {
    if (disk.mountPath !== MOUNT) fail('disk', `mountPath must be ${MOUNT}`);
    else mount = disk.mountPath;
    if (disk.sizeGB !== 1) fail('disk', 'sizeGB must be 1');
    if (typeof disk.name !== 'string' || disk.name === '') fail('disk', 'disk needs a name');
  }

  // env vars
  const env = svc.envVars;
  if (!Array.isArray(env)) return fail('service-shape', 'envVars list is required');
  const seen = new Set();
  const values = new Map();
  for (const e of env) {
    if (!isMap(e) || typeof e.key !== 'string') {
      fail('service-shape', 'every envVars entry needs a key');
      continue;
    }
    const key = e.key;
    if (seen.has(key)) fail('duplicate-key', `${key} appears twice`);
    seen.add(key);
    const fields = Object.keys(e).filter((k) => k !== 'key');
    const hasValue = Object.hasOwn(e, 'value');

    if (key === 'NODE_OPTIONS') fail('node-options', 'NODE_OPTIONS must not be set');
    else if (PROXY_VARS.test(key)) fail('proxy-var', `${key} must not be set`);
    else if (/^(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|GATSBY|NUXT_PUBLIC|PUBLIC)_/.test(key)) {
      if (key !== 'NEXT_PUBLIC_UMS_ENV_LABEL')
        fail(
          'public-name',
          `${key} is client-exposed; only NEXT_PUBLIC_UMS_ENV_LABEL may be public`,
        );
    } else if (!ALLOWED.has(key)) fail('unknown-name', `${key} is not a name the app reads`);

    // Live and PayPal-host scans cover every value, secret name or not. Values are never printed.
    if (hasValue) {
      const v = str(e.value);
      if (LIVE_WORD.test(v)) fail('live-value', `${key} value contains "live"`);
      if (PAYPAL_HOST.test(v)) fail('paypal-host', `${key} value names a PayPal host`);
      if (/production/i.test(v) && !(key === 'NODE_ENV' && v === 'production'))
        fail('live-value', `${key} value names production`);
    }
    if (SECRETS.has(key)) {
      if (hasValue || e.sync !== false || fields.some((f) => f !== 'sync'))
        fail('secret-with-value', `${key} must be exactly "sync: false" with no value`);
      continue;
    }
    for (const f of fields)
      if (f !== 'value')
        fail('service-shape', `${key}: field ${f} is not allowed on a fixed value`);
    if (!hasValue) {
      fail('service-shape', `${key} has no value and is not a secret name`);
      continue;
    }
    const v = str(e.value);
    values.set(key, v);
    if (key in FIXED && v !== FIXED[key])
      fail('fixed-value', `${key} must be the reviewed fixed value`);
    if (!(key in FIXED))
      fail('fixed-value', `${key} has a value but is neither fixed nor a secret name`);
  }
  if (values.get('NEXT_TELEMETRY_DISABLED') !== '1')
    fail('telemetry', 'NEXT_TELEMETRY_DISABLED must be 1');
  for (const k of Object.keys(FIXED)) if (!seen.has(k)) fail('fixed-value', `${k} is missing`);
  for (const k of SECRETS)
    if (!seen.has(k))
      fail('secret-with-value', `${k} is missing (it must be listed with sync: false)`);

  // PGlite directory inside the mount, no traversal.
  const dir = values.get('UMS_PGLITE_DIR');
  if (dir !== undefined) {
    const parts = dir.split('/');
    const inside = mount !== null && dir.startsWith(`${mount}/`) && dir.length > mount.length + 1;
    if (!inside || parts.includes('..') || parts.includes('.') || dir.includes('//'))
      fail('pglite-dir', `UMS_PGLITE_DIR must be a path inside ${MOUNT} with no dot segments`);
  }
}

function main() {
  let parsed;
  try {
    parsed = parseYaml(readFileSync(join(ROOT, 'render.yaml'), 'utf8'));
  } catch (e) {
    fail('parse', e instanceof ParseError ? e.message : 'render.yaml could not be read');
    return;
  }
  for (const k of parsed.dups) fail('duplicate-key', `${k} appears twice in one map`);
  const { root } = parsed;
  if (!isMap(root) || Object.keys(root).some((k) => k !== 'services'))
    return fail('service-shape', 'top level must hold only "services"');
  if (!Array.isArray(root.services) || root.services.length !== 1)
    return fail('service-shape', 'exactly one service is allowed');
  checkService(root.services[0]);
}

main();
if (violations.length === 0) {
  console.log('hosting ok');
  process.exit(0);
}
for (const v of violations) console.log(`hosting: FAIL ${v.rule} ${v.where}`);
process.exit(1);
