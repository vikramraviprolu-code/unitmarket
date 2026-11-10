// Fails when the Google Cloud deployment kit (infra/gcp) holds an unsafe setting. GCP-1, D-049.
//
// The kit is eleven files: a Dockerfile, six bash scripts (the cloud kit adds cloud.sh and lib/cloud-lib.sh),
// service.yaml (the fixed, non-secret environment of the Cloud Run service), service-offline.yaml (the same
// for the prepared second service, INFRA-A) and stack.env (the non-secret names of the stack, INT-CL1). The
// guard reads the folder and its one subfolder lib, as text, with no dependency, and reports every violation
// by rule name. Values are never printed: a line number or a name only.
//
// Rules: kit-files, bytes, strict-mode, account-guard, login, terminal-check, print-secret, secret-read,
// secret-literal, secret-in-env, secret-names, forbidden-name, paypal-host, live-value, paypal-connect,
// db-kind, fixed-value, unknown-name, public-name, value-type, duplicate-key, origin, env-flags,
// env-file, max-instances, min-instances, cpu-throttling, resources, probe, ingress, unauthenticated,
// auto-deploy, deploy-shape, literal-project, literal-value, docker-node, docker-user, docker-cmd,
// docker-env; GCP-2 adds sql-network, sql-protection, sql-ssl, sql-connector, sql-storage, iam-role, scaling,
// read-ifs, image-tag and docker-workdir; INFRA-A adds optional-secret, offline-paypal, offline-secret and
// offline-shape, and applies the instance, env-file, image-tag and deploy rules to each deploy script
// (deploy.sh for the sandbox service, deploy-offline.sh for the offline one); INT-CL1 adds no-delete and lets
// lib/cloud-lib.sh, and only that file, set min 0 or 1, max 1, --no-cpu-throttling and the one environment
// flag --update-env-vars=UMS_PAYPAL_CONNECT=off.
//
// Pinned forms (GCP-2): an instance flag is `--max-instances=1` or `--max-instances 1`; a service.yaml
// value is `KEY: 'value'` or `KEY: "value"` with nothing else on the line.
//
// Every file must be printable ASCII plus LF: a CR, a tab or any other byte can hide text from a reader
// that splits lines differently from the shell or the YAML reader.
//
// Usage: node scripts/check-hosting-gcp.mjs [--root <dir>]   (reads <root>/infra/gcp)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoot } from './lib/walk.mjs';

const ROOT = resolveRoot(process.argv, import.meta.url);
const KIT_DIR = join(ROOT, 'infra', 'gcp');
const KIT = [
  'Dockerfile',
  'cloud.sh',
  'deploy-offline.sh',
  'deploy.sh',
  'lib/cloud-lib.sh',
  'monitoring.sh',
  'service-offline.yaml',
  'service.yaml',
  'set-secret.sh',
  'setup.sh',
  'stack.env',
];
// INT-CL1: the one file that may set the stopped and the running state, and the one environment flag.
const CLOUD_LIB = 'lib/cloud-lib.sh';
const FLAG_OFF_TOKEN = /^--update-env-vars=UMS_PAYPAL_CONNECT=off(?=\s|$)/;
// Each deploy script, the yaml it passes, and the variable that names the image in its IMAGE line.
const DEPLOYERS = {
  'deploy.sh': { yaml: 'service.yaml', imageVar: 'SERVICE' },
  'deploy-offline.sh': { yaml: 'service-offline.yaml', imageVar: 'IMAGE_NAME' },
};
const YAMLS = ['service.yaml', 'service-offline.yaml'];
const SCRIPTS = KIT.filter((f) => f.endsWith('.sh'));

// The names set-secret.sh may store: the `sync: false` names of render.yaml minus UMS_PUBLIC_ORIGIN
// (not a secret; it goes in service.yaml). DATABASE_URL is made by setup.sh and is a secret too.
const REQUIRED = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
  'UMS_OWN_MERCHANT_ID',
  'UMS_OPERATOR_TOTP_KEYS',
];
// INFRA-A: optional secrets of the sandbox service (no value means the feature is off), and the five own
// secrets of the offline service (HARD-OFFLINE added the judge hash) (mapped by deploy-offline.sh to the env names without OFFLINE_).
const OPTIONAL = [
  'UMS_PUBLISHER_PASSCODE_HASH',
  'UMS_JUDGE_PASSCODE_HASH',
  'UMS_OFFER_MAX_MINOR',
  'UMS_AI_ADAPTER',
  'UMS_ANTHROPIC_API_KEY',
];
const OFFLINE = [
  'UMS_OFFLINE_SESSION_SECRET',
  'UMS_OFFLINE_APPROVAL_SECRET',
  'UMS_OFFLINE_LINK_SECRET',
  'UMS_OFFLINE_DEMO_PASSCODE_HASH',
  'UMS_OFFLINE_JUDGE_PASSCODE_HASH',
];
const SETTABLE = [...REQUIRED, ...OPTIONAL, ...OFFLINE];
const SECRETS = new Set([...SETTABLE, 'DATABASE_URL']);
// The names of the sandbox service: the offline script must not name any of them.
const MAIN_SECRETS = new Set([...REQUIRED, ...OPTIONAL, 'DATABASE_URL']);
// Fixed, non-secret values service.yaml must carry exactly. UMS_PAYPAL_CONNECT and UMS_DB have their own rules.
const FIXED = {
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  UMS_MODE: 'sandbox',
  UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
  // DOM-1: the load balancer and Cloud Run's front end each append to X-Forwarded-For (measured
  // 10 Nov 2026 through https://unitmarket.live). service-offline.yaml keeps 1 (run.app only).
  UMS_TRUSTED_PROXIES: '2',
  NEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox',
};
// Fixed values service-offline.yaml must carry exactly. UMS_PAYPAL_CONNECT, UMS_DB and UMS_PUBLIC_ORIGIN
// have their own rules; NEXT_PUBLIC_UMS_ENV_LABEL may be absent (the label comes from stored data) but
// never says anything but Dry run.
const FIXED_OFFLINE = {
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  UMS_MODE: 'offline',
  UMS_AI_ADAPTER: 'scripted',
  UMS_TRUSTED_PROXIES: '1',
};
const PLACEHOLDER_ORIGIN = 'https://pending.invalid';
const RUN_APP_ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/;
// DOM-1: the one custom domain the sandbox service may use (service.yaml only, never the offline one).
const CUSTOM_ORIGIN = 'https://unitmarket.live';
const CMD = 'CMD ["corepack", "pnpm", "--filter", "@umsbx/web", "start"]';

const FORBIDDEN_NAMES = [
  /\bNODE_OPTIONS\b/,
  /\b(?:HTTP|HTTPS|ALL|NO|FTP)_PROXY\b/i,
  /\b(?:NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_TLS_REJECT_UNAUTHORIZED)\b/,
  /\bUMS_MAINTENANCE_FLAG\b/,
  /\bUMS_WEBHOOK_CERT_LEARN_UNTIL\b/,
];
const PAYPAL_HOST = /paypal(?:objects)?\.com/i;
const LIVE_WORD = /(?<![A-Za-z])live(?![a-z])/i;
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /ya29\.[0-9A-Za-z_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const CLIENT_PREFIX = /^(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|GATSBY|NUXT_PUBLIC|PUBLIC)_/;

const violations = [];
const fail = (rule, where) => violations.push({ rule, where });

/** Lines with their 1-based numbers; `code` drops whole-line comments. */
function split(text) {
  return text.split('\n').map((raw, i) => ({ raw, no: i + 1, comment: /^\s*#/.test(raw) }));
}

/** Shell statements: lines joined while they end in a backslash or a pipe. */
function statements(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (l.comment) continue;
    const t = l.raw.replace(/\s+$/, '');
    if (cur === null) cur = { text: '', no: l.no };
    cur.text += `${cur.text ? ' ' : ''}${t.replace(/\\$/, '').trim()}`;
    if (!/(?:\\|\|)$/.test(t)) {
      if (cur.text.trim() !== '') out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim() !== '') out.push(cur);
  return out;
}

/** The kit's files: the folder itself and the one subfolder lib (as lib/<name>). Any other folder is listed with a slash. */
function listKit() {
  const out = [];
  for (const e of readdirSync(KIT_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) out.push(e.name);
    else if (e.name === 'lib')
      for (const f of readdirSync(join(KIT_DIR, 'lib'))) out.push(`lib/${f}`);
    else out.push(`${e.name}/`);
  }
  return out.sort();
}

function main() {
  if (!existsSync(KIT_DIR)) return fail('kit-files', 'infra/gcp is missing');
  const present = listKit();
  for (const f of KIT) if (!present.includes(f)) fail('kit-files', `${f} is missing`);
  for (const f of present)
    if (!KIT.includes(f)) fail('kit-files', `${f} is not in the reviewed kit`);

  const files = {};
  for (const f of KIT) {
    if (!present.includes(f)) continue;
    const raw = readFileSync(join(KIT_DIR, f), 'utf8');
    const bad = raw.search(/[^\x20-\x7E\n]/);
    if (bad !== -1)
      fail('bytes', `${f}: only printable ASCII and LF are allowed (first other byte at ${bad})`);
    files[f] = raw.replace(/[^\x20-\x7E\n]/g, '?');
  }

  const stmts = {};
  const lines = {};
  for (const f of Object.keys(files)) {
    lines[f] = split(files[f]);
    stmts[f] = statements(lines[f]);
  }

  // ---- every file ------------------------------------------------------------------------------
  for (const f of Object.keys(files)) {
    for (const l of lines[f]) {
      for (const re of FORBIDDEN_NAMES)
        if (re.test(l.raw))
          fail('forbidden-name', `${f}:${l.no} names a variable the kit must not set`);
      if (PAYPAL_HOST.test(l.raw)) fail('paypal-host', `${f}:${l.no} names a PayPal host`);
      // DOM-1: the custom domain ends in .live; only service.yaml may name it, and only as the whole
      // origin https://unitmarket.live. Any other "live" on the same line is still refused.
      const liveText = f === 'service.yaml' ? l.raw.split(CUSTOM_ORIGIN).join('') : l.raw;
      if (LIVE_WORD.test(liveText)) fail('live-value', `${f}:${l.no} contains the word live`);
      if (/production/i.test(l.raw) && !/NODE_ENV/.test(l.raw))
        fail('live-value', `${f}:${l.no} names production`);
      if (/\ballUsers\b|\ballAuthenticatedUsers\b/.test(l.raw))
        fail('unauthenticated', `${f}:${l.no} grants access to everyone by IAM`);
      for (const re of SECRET_SHAPES)
        if (re.test(l.raw)) fail('secret-literal', `${f}:${l.no} holds a secret-shaped value`);
      const url = l.raw.match(/postgres(?:ql)?:\/\/[^\s:/@]+:([^@\s]*)@/);
      if (url && !/^(?:\$|%s)/.test(url[1]))
        fail('secret-literal', `${f}:${l.no} holds a database URL with a literal password`);
      // A base image digest (@sha256:<64 hex>) on a FROM line is not a secret; anywhere else it is a token.
      const scan =
        f === 'Dockerfile' && /^FROM\s/.test(l.raw)
          ? l.raw.replace(/@sha256:[0-9a-f]{64}(?![0-9A-Za-z])/, '@sha256:')
          : l.raw;
      for (const tok of scan.split(/[^A-Za-z0-9+_-]/))
        if (tok.length >= 32 && /\d/.test(tok) && /[A-Za-z]/.test(tok) && !/^[A-Z0-9_]+$/.test(tok))
          fail('secret-literal', `${f}:${l.no} holds a long random-looking token`);
      for (const n of SECRETS) {
        if (YAMLS.includes(f)) continue; // secret-in-env covers it
        if (new RegExp(`\\b${n}\\s*[:=]\\s*["']?[^\\s"'$]`).test(l.raw))
          fail('secret-literal', `${f}:${l.no} gives ${n} a literal value`);
      }
      if (EMAIL.test(l.raw)) fail('literal-value', `${f}:${l.no} holds an e-mail address`);
      if (
        /[a-z0-9-]+\.run\.app/.test(l.raw) &&
        !(YAMLS.includes(f) && /^UMS_PUBLIC_ORIGIN:/.test(l.raw))
      )
        fail('literal-value', `${f}:${l.no} holds a run.app host`);
      if (/\bUMS_PGLITE_DIR\b/.test(l.raw))
        fail('db-kind', `${f}:${l.no} names a PGlite directory`);
    }
  }

  // ---- connection, database and instance settings, anywhere ------------------------------------
  for (const f of Object.keys(files)) {
    for (const l of lines[f]) {
      for (const m of l.raw.matchAll(/\bUMS_PAYPAL_CONNECT\s*[:=]\s*["']?([A-Za-z0-9_-]*)/g)) {
        // OPS-SW (D-120): service.yaml, and only that file, may carry 'on'. The approval row (opened from
        // Operations Controls with the authenticator code, D-094 ceiling fixed in code) and the Start switch
        // stay the per-sitting keys; every script, the offline service and cloud:down still set only off.
        const allowOn = f === 'service.yaml' && /^UMS_PAYPAL_CONNECT: (?:'on'|"on")$/.test(l.raw);
        if (m[1] !== 'off' && !allowOn)
          fail(
            'paypal-connect',
            `${f}:${l.no} sets UMS_PAYPAL_CONNECT to something other than off`,
          );
      }
      for (const m of l.raw.matchAll(/\bUMS_DB\b(?!_)\s*[:=]\s*["']?([A-Za-z0-9_-]*)/g))
        if (m[1] !== (f === 'service-offline.yaml' ? 'pglite-memory' : 'postgres'))
          fail(
            'db-kind',
            `${f}:${l.no} sets UMS_DB to something other than ${f === 'service-offline.yaml' ? 'pglite-memory' : 'postgres'}`,
          );
    }
  }
  // Each yaml must carry the connection flag (a missing line must not pass): off, or on in service.yaml only.
  for (const y of YAMLS) {
    const want =
      y === 'service.yaml'
        ? /^UMS_PAYPAL_CONNECT: (?:'off'|"off"|'on'|"on")$/m
        : /^UMS_PAYPAL_CONNECT: (?:'off'|"off")$/m;
    if (files[y] && !want.test(files[y]))
      fail(
        'paypal-connect',
        `${y}: UMS_PAYPAL_CONNECT with the value off${y === 'service.yaml' ? ' or on' : ''} is missing`,
      );
  }

  // ---- instance flags: counted over the code lines of the whole kit -------------------------------
  const code = [];
  for (const f of Object.keys(files)) for (const s of stmts[f]) code.push({ f, ...s });
  const count = (re) => code.flatMap((s) => [...s.text.matchAll(re)].map((m) => ({ s, m })));
  // INFRA-A: a rule about the deploy scripts holds for each of them: exactly one hit in each deploy
  // script, none in any other file.
  const outside = (hits) => hits.some((h) => !(h.s.f in DEPLOYERS));
  // INT-CL1: hits in lib/cloud-lib.sh are allowed too, when they carry one of the values in `libWant`.
  const only = (hits, name, rule, want, libWant) => {
    const bad =
      hits.some(
        (h) => !(h.s.f in DEPLOYERS) && !(h.s.f === CLOUD_LIB && libWant.includes(h.m[1])),
      ) ||
      Object.keys(DEPLOYERS).some((d) => {
        if (!files[d]) return false;
        const mine = hits.filter((h) => h.s.f === d);
        return mine.length !== 1 || mine[0].m[1] !== want;
      });
    if (bad)
      fail(
        rule,
        `${name} must appear exactly once in each deploy script (deploy.sh, deploy-offline.sh), as ${name}=${want} or ${name} ${want}; lib/cloud-lib.sh may also set ${libWant.join(' or ')}`,
      );
  };
  only(count(/--max-instances(?:[=\s]+(\S+))?/g), '--max-instances', 'max-instances', '1', ['1']);
  only(count(/--min-instances(?:[=\s]+(\S+))?/g), '--min-instances', 'min-instances', '1', [
    '0',
    '1',
  ]);
  if (
    count(/(?<![A-Za-z0-9-])--(?:scaling|max|min)(?![A-Za-z0-9-])|\bupdate-scaling\b/g).length > 0
  )
    fail('scaling', 'only --max-instances and --min-instances in deploy.sh set the scale');
  for (const f of Object.keys(files))
    if (/\bmaxScale\b/.test(files[f])) fail('max-instances', `${f} sets a maxScale annotation`);
  for (const f of Object.keys(files))
    if (/\bminScale\b/.test(files[f])) fail('min-instances', `${f} sets a minScale annotation`);
  const nt = count(/(?<![A-Za-z-])--no-cpu-throttling\b/g);
  if (
    nt.some((h) => !(h.s.f in DEPLOYERS) && h.s.f !== CLOUD_LIB) ||
    Object.keys(DEPLOYERS).some((d) => files[d] && nt.filter((h) => h.s.f === d).length !== 1)
  )
    fail(
      'cpu-throttling',
      '--no-cpu-throttling must appear exactly once in each deploy script (deploy.sh, deploy-offline.sh); lib/cloud-lib.sh may also use it',
    );
  if (count(/(?<!no-)--cpu-throttling\b/g).length > 0)
    fail('cpu-throttling', '--cpu-throttling (CPU only while serving) is not allowed');
  const envHits = count(/--env-vars-file/g);
  if (
    outside(envHits) ||
    Object.entries(DEPLOYERS).some(
      ([d, { yaml }]) =>
        files[d] &&
        (envHits.filter((h) => h.s.f === d).length !== 1 ||
          !new RegExp(`--env-vars-file="\\$\\{HERE\\}\\/${yaml.replace('.', '\\.')}"`).test(
            files[d],
          )),
    )
  )
    fail(
      'env-file',
      'each deploy script must pass --env-vars-file="${HERE}/<its yaml>" (service.yaml or service-offline.yaml), once and only that',
    );
  // INT-CL1: the one exception is the token --update-env-vars=UMS_PAYPAL_CONNECT=off, in lib/cloud-lib.sh only.
  for (const h of count(/--(?:set|update|remove)-env-vars|--clear-env-vars/g))
    if (!(h.s.f === CLOUD_LIB && FLAG_OFF_TOKEN.test(h.s.text.slice(h.m.index))))
      fail(
        'env-flags',
        `${h.s.f}:${h.s.no} environment values must come from the service yaml files only (lib/cloud-lib.sh may set the connection flag to off)`,
      );
  for (const h of count(/--(?:set|update)-env-vars[= ]\S*?\b([A-Z][A-Z0-9_]*)=/g))
    if (SECRETS.has(h.m[1]))
      fail('secret-in-env', `${h.s.f}:${h.s.no} passes a secret name as an env var`);
  if (count(/\bgcloud\s+(?:beta\s+)?builds\s+triggers\b|--source\b|--git-repo\b/g).length > 0)
    fail('auto-deploy', 'no build trigger, no deploy from source or from Git');

  // INT-CL1: a Cloud Run deploy belongs to the two deploy scripts; the cloud kit runs deploy.sh and nothing else.
  for (const s of code)
    if (!(s.f in DEPLOYERS) && /\bgcloud\s+(?:beta\s+)?run\s+deploy\b/.test(s.text))
      fail(
        'deploy-shape',
        `${s.f}:${s.no} a gcloud run deploy outside deploy.sh and deploy-offline.sh`,
      );

  // ---- the deploy statements -----------------------------------------------------------------------
  for (const d of Object.keys(DEPLOYERS)) {
    if (!files[d]) continue;
    const deploys = (stmts[d] ?? []).filter((s) => /\bgcloud\s+run\s+deploy\b/.test(s.text));
    if (deploys.length !== 1) {
      fail('deploy-shape', `${d} must hold exactly one gcloud run deploy`);
      continue;
    }
    const x = deploys[0].text;
    if (!/^gcloud run deploy "\$SERVICE" /.test(x))
      fail('deploy-shape', `the deploy in ${d} must name "$SERVICE"`);
    if (!/(?<!no-)--allow-unauthenticated\b/.test(x))
      fail(
        'unauthenticated',
        `the service of ${d} must be public (--allow-unauthenticated): webhooks and judges need it`,
      );
    if (!/--ingress=all(?:\s|$)/.test(x))
      fail('ingress', `the service of ${d} needs --ingress=all`);
    if (!/--memory=2Gi(?:\s|$)/.test(x)) fail('resources', `${d}: --memory=2Gi is required`);
    if (!/--cpu=1(?:\s|$)/.test(x)) fail('resources', `${d}: --cpu=1 is required`);
    const conc = x.match(/--concurrency=(\d+)(?:\s|$)/);
    if (!conc || Number(conc[1]) < 1 || Number(conc[1]) > 40)
      fail('resources', `${d}: --concurrency must be given, 1 to 40`);
    const probe = x.match(/--startup-probe=(\S+)/);
    if (!probe || !probe[1].includes('httpGet.path=/healthz'))
      fail('probe', `${d}: a startup probe on /healthz is required`);
    if (!/--set-secrets="\$SECRET_FLAGS"/.test(x))
      fail('deploy-shape', `${d}: secrets must be mapped with --set-secrets="$SECRET_FLAGS"`);
    if (d === 'deploy.sh') {
      if (!/--add-cloudsql-instances="\$CONNECTION"/.test(x))
        fail('deploy-shape', 'the Cloud SQL instance must be attached');
    } else {
      // The offline service has no database and runs as its own account, not the sandbox one.
      if (/cloudsql/i.test(x)) fail('offline-shape', `${d}: the offline service has no Cloud SQL`);
      if (!/--service-account="\$OFFLINE_SA"/.test(x))
        fail('offline-shape', `${d}: the offline service must run as "$OFFLINE_SA"`);
    }
  }
  const unauth = count(/(?<!no-)--allow-unauthenticated\b/g);
  if (
    unauth.some((h) => !(h.s.f in DEPLOYERS && /\bgcloud run deploy\b/.test(h.s.text))) ||
    Object.keys(DEPLOYERS).some((d) => files[d] && unauth.filter((h) => h.s.f === d).length > 1)
  )
    fail(
      'unauthenticated',
      '--allow-unauthenticated is only for the two service deploys, once in each',
    );

  // ---- the database instance and IAM (GCP-2) ----------------------------------------------------
  if (count(/(?<![A-Za-z0-9-])--authorized-networks\b/g).length > 0)
    fail(
      'sql-network',
      'no --authorized-networks, with any value: only the connector or the Auth Proxy',
    );
  if (
    count(/(?<![A-Za-z0-9-])--no-(?:deletion-protection|backup|enable-point-in-time-recovery)\b/g)
      .length > 0
  )
    fail(
      'sql-protection',
      'deletion protection, backups and point in time recovery may not be switched off',
    );
  const creates = code.filter((s) =>
    /\bgcloud\s+(?:beta\s+)?sql\s+instances\s+create\b/.test(s.text),
  );
  if (files['setup.sh'] && creates.length !== 1)
    fail('sql-protection', 'setup.sh must hold exactly one gcloud sql instances create');
  else if (creates.length === 1) {
    const c = creates[0].text;
    const need = (flag) => new RegExp(`(?<![A-Za-z0-9-])${flag}(?![A-Za-z0-9=-])`).test(c);
    for (const flag of ['--deletion-protection', '--backup', '--enable-point-in-time-recovery'])
      if (!need(flag))
        fail('sql-protection', `the instance needs ${flag} (no value, not switched off)`);
  }
  const flagValues = (re) => code.flatMap((s) => [...s.text.matchAll(re)].map((m) => m[1]));
  const ssl = flagValues(/(?<![A-Za-z0-9-])--ssl-mode(?:[=\s]+(\S*))?/g);
  if ((files['setup.sh'] && ssl.length === 0) || ssl.some((v) => v !== 'ENCRYPTED_ONLY'))
    fail('sql-ssl', 'the instance needs --ssl-mode=ENCRYPTED_ONLY, and no other --ssl-mode');
  const conn = flagValues(/(?<![A-Za-z0-9-])--connector-enforcement(?:[=\s]+(\S*))?/g);
  if ((files['setup.sh'] && conn.length === 0) || conn.some((v) => v !== 'REQUIRED'))
    fail(
      'sql-connector',
      'the instance needs --connector-enforcement=REQUIRED, and no other value',
    );
  const lim = flagValues(/(?<![A-Za-z0-9-])--storage-auto-increase-limit(?:[=\s]+(\S*))?/g);
  if (
    (files['setup.sh'] && lim.length === 0) ||
    lim.some((v) => !/^[1-9][0-9]{0,2}$/.test(v ?? '') || Number(v) > 100)
  )
    fail('sql-storage', 'the instance needs --storage-auto-increase-limit=N (GB), N from 1 to 100');
  for (const s of code) {
    if (/\broles\/(?:owner|editor)\b/.test(s.text))
      fail('iam-role', `${s.f}:${s.no} names roles/owner or roles/editor`);
    const bind = /\b(?:add-iam-policy-binding|set-iam-policy|remove-iam-policy-binding)\b/.test(
      s.text,
    );
    const roles = [...s.text.matchAll(/--role[=\s]+"?([^"\s]+)"?/g)].map((m) => m[1]);
    // HARD-OFFLINE: one binding names one member, so the member check below sees all of it.
    if (bind && (s.text.match(/--member(?![A-Za-z-])/g) ?? []).length !== 1)
      fail('iam-role', `${s.f}:${s.no} an IAM binding must name exactly one --member`);
    if (/\bprojects\s+add-iam-policy-binding\b/.test(s.text)) {
      if (roles.length !== 1 || roles[0] !== 'roles/cloudsql.client')
        fail(
          'iam-role',
          `${s.f}:${s.no} a project-level binding may only be roles/cloudsql.client`,
        );
    } else if (/\bsecrets\s+add-iam-policy-binding\b/.test(s.text)) {
      if (roles.length !== 1 || roles[0] !== 'roles/secretmanager.secretAccessor')
        fail(
          'iam-role',
          `${s.f}:${s.no} a secret binding may only be roles/secretmanager.secretAccessor`,
        );
    } else if (bind)
      fail('iam-role', `${s.f}:${s.no} an IAM binding that is not in the reviewed kit`);
    else if (/\broles\/secretmanager\b/.test(s.text))
      fail('iam-role', `${s.f}:${s.no} a Secret Manager role outside a per-secret binding`);
  }
  // The image tag carries the commit as well as the tag name (GCP-2); each deploy script has the rule.
  for (const [name, { imageVar }] of Object.entries(DEPLOYERS)) {
    if (!files[name]) continue;
    const d = files[name];
    const images = d.match(/^IMAGE=.*$/gm) ?? [];
    if (
      images.length !== 1 ||
      !new RegExp(`^IMAGE="[^"]*\\/\\$\\{${imageVar}\\}:\\$\\{TAG\\}-\\$\\{COMMIT\\}"$`).test(
        images[0],
      ) ||
      !/^COMMIT="\$\{TAG_COMMIT:0:12\}"$/m.test(d)
    )
      fail(
        'image-tag',
        `${name}: the image tag must be \${TAG}-\${COMMIT}, with COMMIT the first 12 characters of the tag commit`,
      );
  }

  // ---- scripts -----------------------------------------------------------------------------------
  for (const f of SCRIPTS) {
    if (!files[f]) continue;
    if (!files[f].startsWith('#!/usr/bin/env bash\n'))
      fail('strict-mode', `${f} must start with #!/usr/bin/env bash`);
    if (!/^set -euo pipefail$/m.test(files[f])) fail('strict-mode', `${f} lacks set -euo pipefail`);
    for (const s of stmts[f]) {
      if (/^set\s+\+[A-Za-z]|^set\s+\+o\b/.test(s.text))
        fail('strict-mode', `${f}:${s.no} switches a safety option off`);
      if (
        /\bset\s+-[A-Za-z]*[xv]|\s-o\s+(?:xtrace|verbose)\b|\bbash\s+-[A-Za-z]*x|\bxtrace\b|\bBASH_XTRACEFD\b|\bPS4\b/.test(
          s.text,
        )
      )
        fail('print-secret', `${f}:${s.no} turns tracing on, which would print secrets`);
      // GCP-2: no copy of a value to a file or a dump of the shell state. Applied to every script.
      if (
        /(?<![A-Za-z0-9_./-])tee(?![A-Za-z0-9_-])|\b(?:declare|typeset)\s+-[A-Za-z]*p|\bexport\s+-[A-Za-z]*p\b|\bprintenv\b/.test(
          s.text,
        )
      )
        fail(
          'print-secret',
          `${f}:${s.no} copies or dumps shell state (tee, declare -p, export -p, printenv)`,
        );
      if (
        /\b(?:echo|printf|cat|tee|die)\b[^|]*\$\{?[A-Za-z_]*(?:PASS|SECRET|TOKEN|VALUE|DATABASE_URL|CONFIRM|CREDENTIAL|KEY)/.test(
          s.text,
        ) &&
        !/gcloud secrets versions add/.test(s.text)
      )
        fail('print-secret', `${f}:${s.no} prints a variable that may hold a secret`);
      if (/\bsecrets\s+versions\s+access\b/.test(s.text))
        fail('secret-read', `${f}:${s.no} reads a secret value back`);
      if (/\bgcloud\s+auth\s+(?!list\b)/.test(s.text))
        fail('login', `${f}:${s.no} signs in; the owner signs in beforehand`);
      if (/\bgcloud\s+config\s+set\b/.test(s.text))
        fail('literal-project', `${f}:${s.no} sets a gcloud default`);
      // INT-CL1: nothing in the kit deletes. The quoted text of a message (echo, printf, die, say, warn) is not a
      // statement, so a message may say the word; anything else with the word fails, a variable holding it included.
      // A quoted string that holds a command substitution ($( or a backtick) is not stripped: it runs.
      if (
        /\bdelete\b/.test(
          s.text.replace(
            /\b(?:echo|printf|die|die_[a-z]+|say|warn)\s+(?:-[A-Za-z]+\s+)*(?:"(?:(?!\$\(|`)(?:[^"\\]|\\.))*"|'[^']*')/g,
            '',
          ),
        )
      )
        fail('no-delete', `${f}:${s.no} a statement with the word delete`);
      for (const m of s.text.matchAll(/--(project|region)(?:=|\s+)(\S?)/g))
        if (m[2] !== '"' && m[2] !== '$')
          fail('literal-project', `${f}:${s.no} gives --${m[1]} a literal value`);
    }
    // D-099 permits token credentials only in the sandbox deployer. Keep the account
    // fallback and exact fail-closed condition; other scripts still need an account.
    const accountGuard = /^\[ -n "\$ACTIVE_ACCOUNT" \] \|\| die/m.test(files[f]);
    const tokenOrAccountGuard =
      f === 'deploy.sh' &&
      /^\[ -n "\$\{CLOUDSDK_AUTH_ACCESS_TOKEN:-\}" \] \|\| \[ -n "\$ACTIVE_ACCOUNT" \] \|\| die/m.test(
        files[f],
      );
    if (
      !/gcloud auth list --filter=status:ACTIVE/.test(files[f]) ||
      !(accountGuard || tokenOrAccountGuard)
    )
      fail('account-guard', `${f} must refuse to run without its supported credentials`);
  }
  if (files['set-secret.sh']) {
    const t = files['set-secret.sh'];
    if (!/\[ -t 0 \]/.test(t))
      fail('terminal-check', 'set-secret.sh must refuse without a terminal ([ -t 0 ])');
    const reads = stmts['set-secret.sh'].filter((s) => /\bread\b/.test(s.text));
    if (reads.length === 0)
      fail('terminal-check', 'set-secret.sh must read the value with a hidden prompt');
    for (const s of reads) {
      if (!/\bread\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*s[A-Za-z]*\s/.test(s.text))
        fail(
          'terminal-check',
          `set-secret.sh:${s.no} reads without -s (the typed value would show)`,
        );
      const flags = s.text.replace(/^.*?\bread\b/, '').split(/["$]/)[0];
      if (!/^IFS= read\s/.test(s.text) || !/(?:^|\s)-[A-Za-z]*r[A-Za-z]*(?=\s)/.test(flags))
        fail(
          'read-ifs',
          `set-secret.sh:${s.no} must read with IFS= read -r so spaces and backslashes are kept`,
        );
    }
    const m = t.match(/case "\$NAME" in\n([\s\S]*?)\) ;;/);
    const got = m
      ? m[1]
          .split('|')
          .map((x) => x.trim())
          .filter(Boolean)
          .sort()
      : [];
    if (got.join(',') !== [...SETTABLE].sort().join(','))
      fail(
        'secret-names',
        'set-secret.sh must allow exactly the ten required, five optional and five offline secret names',
      );
  }
  // A name list assignment must hold exactly the given names (no more, no fewer).
  const listIs = (f, variable, want, rule, what) => {
    if (!files[f]) return;
    const m = files[f].match(new RegExp(`^${variable}="([^"]*)"$`, 'm'));
    const got = m ? m[1].split(' ').filter(Boolean).sort() : [];
    if (got.join(',') !== [...want].sort().join(','))
      fail(rule, `${f}: ${variable} must be ${what}`);
  };
  for (const f of ['setup.sh', 'deploy.sh'])
    listIs(
      f,
      'SECRET_NAMES',
      [...REQUIRED, 'DATABASE_URL'],
      'secret-names',
      'DATABASE_URL plus the ten required names',
    );
  for (const f of ['setup.sh', 'deploy.sh'])
    listIs(f, 'OPTIONAL_SECRET_NAMES', OPTIONAL, 'secret-names', 'the five optional names');
  for (const f of ['setup.sh', 'deploy-offline.sh'])
    listIs(f, 'OFFLINE_SECRET_NAMES', OFFLINE, 'secret-names', 'the five offline names');

  // ---- optional secrets never stop the sandbox deploy (INFRA-A) ----------------------------------
  if (files['deploy.sh']) {
    let inLoop = false;
    let sawLoop = false;
    for (const s of stmts['deploy.sh']) {
      if (/^for NAME in \$OPTIONAL_SECRET_NAMES; do$/.test(s.text)) {
        inLoop = true;
        sawLoop = true;
      } else if (inLoop && /^done$/.test(s.text)) inLoop = false;
      else if (inLoop && /(?:^|[\s;&|])(?:die|exit)\b/.test(s.text))
        fail(
          'optional-secret',
          `deploy.sh:${s.no} stops the deploy inside the optional secret loop`,
        );
      if (/\bdie\b[^\n]*\bOPTIONAL_[A-Z_]+/.test(s.text))
        fail('optional-secret', `deploy.sh:${s.no} stops the deploy on an optional secret`);
    }
    if (!sawLoop)
      fail(
        'optional-secret',
        'deploy.sh must look at each optional secret in "for NAME in $OPTIONAL_SECRET_NAMES; do"',
      );
  }

  // ---- the offline script: no payment name, no database (INFRA-A) ---------------------------------
  for (const s of stmts['deploy-offline.sh'] ?? []) {
    const named = [...MAIN_SECRETS].find((n) => new RegExp(`\\b${n}\\b`).test(s.text));
    if (named)
      fail(
        'offline-secret',
        `deploy-offline.sh:${s.no} names ${named}, a secret of the sandbox service`,
      );
    else if (/paypal/i.test(s.text))
      fail('offline-paypal', `deploy-offline.sh:${s.no} names PayPal`);
    if (/cloudsql|CONNECTION\b/i.test(s.text))
      fail('offline-shape', `deploy-offline.sh:${s.no} names Cloud SQL`);
  }

  // ---- the offline account is pinned and reads only the offline secrets (INFRA-A review F2) -------------
  const OFFLINE_SA_LINE = 'OFFLINE_SA="ums-offline@${PROJECT_ID}.iam.gserviceaccount.com"';
  for (const f of ['setup.sh', 'deploy-offline.sh']) {
    if (!files[f]) continue;
    const sets = stmts[f].filter((s) => /^OFFLINE_SA\s*\+?=/.test(s.text));
    if (sets.length !== 1 || sets[0].text !== OFFLINE_SA_LINE)
      fail('offline-shape', `${f}: OFFLINE_SA must be set once, exactly as ${OFFLINE_SA_LINE}`);
    if (f === 'deploy-offline.sh')
      for (const s of stmts[f])
        if (/\bRUNTIME_SA\b|ums-runtime/.test(s.text))
          fail('offline-shape', `${f}:${s.no} names the sandbox runtime account`);
  }
  for (const f of Object.keys(files)) {
    if (!f.endsWith('.sh')) continue;
    const loops = [];
    for (const s of stmts[f]) {
      if (/^for\b.*; do$/.test(s.text)) loops.push(s.text);
      else if (/^done\b/.test(s.text)) loops.pop();
      else if (/\badd-iam-policy-binding\b/.test(s.text)) {
        const member = s.text.match(/--member[=\s]+"?([^"\s]+)"?/)?.[1] ?? '';
        const isSecret = /\bsecrets\s+add-iam-policy-binding\b/.test(s.text);
        const inOffline =
          isSecret && loops[loops.length - 1] === 'for NAME in $OFFLINE_SECRET_NAMES; do';
        const toOffline = /OFFLINE_SA|ums-offline/.test(member);
        if (toOffline && !inOffline)
          fail(
            'offline-shape',
            `${f}:${s.no} binds the offline account outside "for NAME in $OFFLINE_SECRET_NAMES; do"`,
          );
        if (
          isSecret &&
          loops[loops.length - 1] === 'for NAME in $OFFLINE_SECRET_NAMES; do' &&
          member !== 'serviceAccount:${OFFLINE_SA}'
        )
          fail(
            'offline-shape',
            `${f}:${s.no} the offline secret loop binds only "${'${OFFLINE_SA}'}"`,
          );
      }
    }
  }

  // ---- OPTIONAL_ON and SECRET_FLAGS are built from the reviewed lines only (INFRA-A review F3) ------
  if (files['deploy.sh']) {
    const loops = [];
    const okOptional = [
      ['OPTIONAL_ON=""', null],
      ['OPTIONAL_ON="${OPTIONAL_ON} ${NAME}"', 'for NAME in $OPTIONAL_SECRET_NAMES; do'],
      ['OPTIONAL_ON="${OPTIONAL_ON/ UMS_AI_ADAPTER/}"', null],
    ];
    const okFlags = [
      ['SECRET_FLAGS=""', null],
      [
        'SECRET_FLAGS="${SECRET_FLAGS:+${SECRET_FLAGS},}${NAME}=${NAME}:latest"',
        'for NAME in $SECRET_NAMES; do',
      ],
      ['SECRET_FLAGS="${SECRET_FLAGS},${NAME}=${NAME}:latest"', 'for NAME in $OPTIONAL_ON; do'],
    ];
    for (const s of stmts['deploy.sh']) {
      if (/^for\b.*; do$/.test(s.text)) loops.push(s.text);
      else if (/^done\b/.test(s.text)) loops.pop();
      const here = loops[loops.length - 1] ?? null;
      for (const [name, ok] of [
        ['OPTIONAL_ON', okOptional],
        ['SECRET_FLAGS', okFlags],
      ]) {
        if (!new RegExp(`(?:^|[\\s;&|(])${name}\\s*\\+?=`).test(s.text)) continue;
        if (!ok.some(([text, loop]) => s.text === text && (loop === null || loop === here)))
          fail(
            name === 'OPTIONAL_ON' ? 'optional-secret' : 'deploy-shape',
            `deploy.sh:${s.no} sets ${name} in a way the reviewed kit does not`,
          );
      }
    }
    const loopHeaders = stmts['deploy.sh'].filter((s) =>
      /^for NAME in \$OPTIONAL_ON; do$/.test(s.text),
    );
    if (loopHeaders.length !== 1)
      fail(
        'optional-secret',
        'deploy.sh must map the optional names in "for NAME in $OPTIONAL_ON; do"',
      );
  }

  // ---- the offline SECRET_FLAGS are built from the reviewed lines only (HARD-OFFLINE) ----------------
  // Each own secret is mapped to its name without OFFLINE_ and to nothing else, so the judge hash can
  // only become UMS_JUDGE_PASSCODE_HASH. The list the loop walks is pinned by the OFFLINE_SECRET_NAMES rule.
  if (files['deploy-offline.sh']) {
    const loops = [];
    const loop = 'for NAME in $OFFLINE_SECRET_NAMES; do';
    const okFlags = [
      ['SECRET_FLAGS=""', null],
      [
        'SECRET_FLAGS="${SECRET_FLAGS:+${SECRET_FLAGS},}UMS_${NAME#UMS_OFFLINE_}=${NAME}:latest"',
        loop,
      ],
    ];
    let mapped = 0;
    for (const s of stmts['deploy-offline.sh']) {
      if (/^for\b.*; do$/.test(s.text)) loops.push(s.text);
      else if (/^done\b/.test(s.text)) loops.pop();
      if (!/(?:^|[\s;&|(])SECRET_FLAGS\s*\+?=/.test(s.text)) continue;
      const here = loops[loops.length - 1] ?? null;
      if (!okFlags.some(([text, l]) => s.text === text && (l === null || l === here)))
        fail(
          'deploy-shape',
          `deploy-offline.sh:${s.no} sets SECRET_FLAGS in a way the reviewed kit does not`,
        );
      else if (s.text !== 'SECRET_FLAGS=""') mapped += 1;
    }
    if (mapped !== 1)
      fail(
        'deploy-shape',
        'deploy-offline.sh must map its secrets once, in "for NAME in $OFFLINE_SECRET_NAMES; do"',
      );
  }

  // ---- service.yaml and service-offline.yaml -------------------------------------------------------
  for (const y of YAMLS) {
    if (!files[y]) continue;
    const offline = y === 'service-offline.yaml';
    const fixed = offline ? FIXED_OFFLINE : FIXED;
    const seen = new Set();
    for (const l of lines[y]) {
      if (l.comment || l.raw.trim() === '') continue;
      const m = l.raw.match(/^([A-Za-z_][A-Za-z0-9_]*): (?:'([^'\\]*)'|"([^"\\]*)")$/);
      if (!m) {
        fail(
          'value-type',
          `${y}:${l.no} must be KEY: 'value' or KEY: "value" (a quoted string, nothing else on the line)`,
        );
        continue;
      }
      const key = m[1];
      const value = m[2] ?? m[3];
      if (seen.has(key)) fail('duplicate-key', `${y}:${l.no} repeats ${key}`);
      seen.add(key);
      if (key === 'UMS_PAYPAL_CONNECT' || key === 'UMS_DB' || key === 'UMS_PUBLIC_ORIGIN') {
        if (
          key === 'UMS_PUBLIC_ORIGIN' &&
          value !== PLACEHOLDER_ORIGIN &&
          !RUN_APP_ORIGIN.test(value) &&
          (offline || value !== CUSTOM_ORIGIN)
        )
          fail(
            'origin',
            offline
              ? 'UMS_PUBLIC_ORIGIN must be the placeholder or an https run.app origin with no path'
              : `UMS_PUBLIC_ORIGIN must be the placeholder, an https run.app origin with no path, or ${CUSTOM_ORIGIN}`,
          );
        const wantDb = offline ? 'pglite-memory' : 'postgres';
        if (key === 'UMS_DB' && value !== wantDb) fail('db-kind', `${y}: UMS_DB must be ${wantDb}`);
      } else if (key in fixed) {
        if (value !== fixed[key])
          fail('fixed-value', `${y}: ${key} must be the reviewed fixed value`);
      } else if (offline && key === 'NEXT_PUBLIC_UMS_ENV_LABEL') {
        if (value !== 'Dry run')
          fail('fixed-value', `${y}: ${key} may only say Dry run (or be left out)`);
      } else if (SECRETS.has(key))
        fail('secret-in-env', `${y}:${l.no} lists ${key}; secrets come from Secret Manager`);
      else if (offline && /paypal/i.test(key))
        fail('offline-paypal', `${y}:${l.no} names a PayPal setting; the offline service has none`);
      else if (CLIENT_PREFIX.test(key))
        fail(
          'public-name',
          `${key} is client-exposed; only NEXT_PUBLIC_UMS_ENV_LABEL may be public`,
        );
      else fail('unknown-name', `${y}: ${key} is not a name the kit may set`);
    }
    for (const k of Object.keys(fixed))
      if (!seen.has(k)) fail('fixed-value', `${y}: ${k} is missing`);
    if (!seen.has('UMS_DB'))
      fail(
        'db-kind',
        `${y}: UMS_DB with the value ${offline ? 'pglite-memory' : 'postgres'} is missing`,
      );
    if (!seen.has('UMS_PUBLIC_ORIGIN')) fail('origin', `${y}: UMS_PUBLIC_ORIGIN is missing`);
  }

  // ---- Dockerfile --------------------------------------------------------------------------------
  if (files['Dockerfile']) {
    const ds = stmts['Dockerfile'];
    const froms = ds.filter((s) => /^FROM\b/.test(s.text));
    if (froms.length === 0) fail('docker-node', 'the Dockerfile has no FROM');
    for (const s of froms)
      if (!/^FROM node:22\.22\.0(?:-[a-z0-9.]+)*@sha256:[0-9a-f]{64}(?: AS [a-z]+)?$/.test(s.text))
        fail(
          'docker-node',
          `Dockerfile:${s.no} must start from node:22.22.0 pinned by an @sha256 digest`,
        );
    // Every stage keeps WORKDIR /app: the migrations path is resolved at build time (GCP-2).
    let stage = -1;
    const workdirs = [];
    for (const s of ds) {
      if (/^FROM\b/.test(s.text)) {
        stage += 1;
        workdirs[stage] = [];
      } else if (stage >= 0 && /^WORKDIR\b/.test(s.text)) workdirs[stage].push(s.text);
    }
    workdirs.forEach((w, i) => {
      if (w.length === 0 || w.some((x) => x !== 'WORKDIR /app'))
        fail('docker-workdir', `Dockerfile stage ${i + 1} must use WORKDIR /app, and only that`);
    });
    const users = ds.filter((s) => /^USER\b/.test(s.text));
    const last = users[users.length - 1];
    if (!last || /^USER\s+(?:root|0)(?::.*)?$/.test(last.text))
      fail('docker-user', 'the image must end as a non-root USER');
    if (!ds.some((s) => s.text === CMD))
      fail('docker-cmd', 'CMD must be the reviewed start command');
    for (const s of ds) {
      if (/^(?:COPY|ADD)\b/.test(s.text) && /\.env\b/.test(s.text))
        fail('docker-env', `Dockerfile:${s.no} copies an env file`);
      if (/^ADD\s+(?:--\S+\s+)*(?:https?|ftp):/i.test(s.text))
        fail('docker-env', `Dockerfile:${s.no} fetches a remote file with ADD`);
    }
  }
}

main();
if (violations.length === 0) {
  console.log('hosting-gcp ok');
  process.exit(0);
}
const seen = new Set();
for (const v of violations) {
  const line = `hosting-gcp: FAIL ${v.rule} ${v.where}`;
  if (!seen.has(line)) console.log(line);
  seen.add(line);
}
process.exit(1);
