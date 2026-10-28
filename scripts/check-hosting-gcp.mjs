// Fails when the Google Cloud deployment kit (infra/gcp) holds an unsafe setting. GCP-1, D-049.
//
// The kit is six files: a Dockerfile, four bash scripts and service.yaml (the fixed, non-secret
// environment of the Cloud Run service). This guard reads them as text, with no dependency, and reports
// every violation by rule name. Values are never printed: a line number or a name only.
//
// Rules: kit-files, bytes, strict-mode, account-guard, login, terminal-check, print-secret, secret-read,
// secret-literal, secret-in-env, secret-names, forbidden-name, paypal-host, live-value, paypal-connect,
// db-kind, fixed-value, unknown-name, public-name, value-type, duplicate-key, origin, env-flags,
// env-file, max-instances, min-instances, cpu-throttling, resources, probe, ingress, unauthenticated,
// auto-deploy, deploy-shape, literal-project, literal-value, docker-node, docker-user, docker-cmd,
// docker-env; GCP-2 adds sql-network, sql-protection, sql-ssl, sql-connector, sql-storage, iam-role, scaling,
// read-ifs, image-tag and docker-workdir.
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
  'deploy.sh',
  'monitoring.sh',
  'service.yaml',
  'set-secret.sh',
  'setup.sh',
];
const SCRIPTS = KIT.filter((f) => f.endsWith('.sh'));

// The names set-secret.sh may store: the `sync: false` names of render.yaml minus UMS_PUBLIC_ORIGIN
// (not a secret; it goes in service.yaml). DATABASE_URL is made by setup.sh and is a secret too.
const SETTABLE = [
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
const SECRETS = new Set([...SETTABLE, 'DATABASE_URL']);
// Fixed, non-secret values service.yaml must carry exactly. UMS_PAYPAL_CONNECT and UMS_DB have their own rules.
const FIXED = {
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  UMS_MODE: 'sandbox',
  UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
  UMS_TRUSTED_PROXIES: '1',
  NEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox',
};
const PLACEHOLDER_ORIGIN = 'https://pending.invalid';
const RUN_APP_ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/;
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

function main() {
  if (!existsSync(KIT_DIR)) return fail('kit-files', 'infra/gcp is missing');
  const present = readdirSync(KIT_DIR).sort();
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
      if (LIVE_WORD.test(l.raw)) fail('live-value', `${f}:${l.no} contains the word live`);
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
        if (f === 'service.yaml') continue; // secret-in-env covers it
        if (new RegExp(`\\b${n}\\s*[:=]\\s*["']?[^\\s"'$]`).test(l.raw))
          fail('secret-literal', `${f}:${l.no} gives ${n} a literal value`);
      }
      if (EMAIL.test(l.raw)) fail('literal-value', `${f}:${l.no} holds an e-mail address`);
      if (
        /[a-z0-9-]+\.run\.app/.test(l.raw) &&
        !(f === 'service.yaml' && /^UMS_PUBLIC_ORIGIN:/.test(l.raw))
      )
        fail('literal-value', `${f}:${l.no} holds a run.app host`);
      if (/\bUMS_PGLITE_DIR\b/.test(l.raw))
        fail('db-kind', `${f}:${l.no} names a PGlite directory`);
    }
  }

  // ---- connection, database and instance settings, anywhere ------------------------------------
  let connectFound = false;
  for (const f of Object.keys(files)) {
    for (const l of lines[f]) {
      for (const m of l.raw.matchAll(/\bUMS_PAYPAL_CONNECT\s*[:=]\s*["']?([A-Za-z0-9_-]*)/g)) {
        connectFound = true;
        if (m[1] !== 'off')
          fail(
            'paypal-connect',
            `${f}:${l.no} sets UMS_PAYPAL_CONNECT to something other than off`,
          );
      }
      for (const m of l.raw.matchAll(/\bUMS_DB\b(?!_)\s*[:=]\s*["']?([A-Za-z0-9_-]*)/g))
        if (m[1] !== 'postgres')
          fail('db-kind', `${f}:${l.no} sets UMS_DB to something other than postgres`);
    }
  }
  if (!connectFound) fail('paypal-connect', 'UMS_PAYPAL_CONNECT with the value off is missing');

  // ---- instance flags: counted over the code lines of the whole kit -------------------------------
  const code = [];
  for (const f of Object.keys(files)) for (const s of stmts[f]) code.push({ f, ...s });
  const count = (re) => code.flatMap((s) => [...s.text.matchAll(re)].map((m) => ({ s, m })));
  const only = (hits, name, rule, want) => {
    if (hits.length !== 1 || hits[0].s.f !== 'deploy.sh' || hits[0].m[1] !== want)
      fail(
        rule,
        `${name} must appear exactly once, in deploy.sh, as ${name}=${want} or ${name} ${want}`,
      );
  };
  only(count(/--max-instances(?:[=\s]+(\S+))?/g), '--max-instances', 'max-instances', '1');
  only(count(/--min-instances(?:[=\s]+(\S+))?/g), '--min-instances', 'min-instances', '1');
  if (
    count(/(?<![A-Za-z0-9-])--(?:scaling|max|min)(?![A-Za-z0-9-])|\bupdate-scaling\b/g).length > 0
  )
    fail('scaling', 'only --max-instances and --min-instances in deploy.sh set the scale');
  for (const f of Object.keys(files))
    if (/\bmaxScale\b/.test(files[f])) fail('max-instances', `${f} sets a maxScale annotation`);
  for (const f of Object.keys(files))
    if (/\bminScale\b/.test(files[f])) fail('min-instances', `${f} sets a minScale annotation`);
  const nt = count(/(?<![A-Za-z-])--no-cpu-throttling\b/g);
  if (nt.length !== 1 || nt[0].s.f !== 'deploy.sh')
    fail('cpu-throttling', '--no-cpu-throttling must appear exactly once, in deploy.sh');
  if (count(/(?<!no-)--cpu-throttling\b/g).length > 0)
    fail('cpu-throttling', '--cpu-throttling (CPU only while serving) is not allowed');
  if (
    count(/--env-vars-file/g).length !== 1 ||
    !/--env-vars-file="\$\{HERE\}\/service\.yaml"/.test(files['deploy.sh'] ?? '')
  )
    fail(
      'env-file',
      'deploy.sh must pass --env-vars-file="${HERE}/service.yaml", once and only that',
    );
  if (count(/--(?:set|update|remove)-env-vars|--clear-env-vars/g).length > 0)
    fail('env-flags', 'environment values must come from service.yaml only');
  for (const h of count(/--(?:set|update)-env-vars[= ]\S*?\b([A-Z][A-Z0-9_]*)=/g))
    if (SECRETS.has(h.m[1]))
      fail('secret-in-env', `${h.s.f}:${h.s.no} passes a secret name as an env var`);
  if (count(/\bgcloud\s+(?:beta\s+)?builds\s+triggers\b|--source\b|--git-repo\b/g).length > 0)
    fail('auto-deploy', 'no build trigger, no deploy from source or from Git');

  // ---- the deploy statement ---------------------------------------------------------------------
  const deploys = (stmts['deploy.sh'] ?? []).filter((s) =>
    /\bgcloud\s+run\s+deploy\b/.test(s.text),
  );
  if (deploys.length !== 1)
    fail('deploy-shape', 'deploy.sh must hold exactly one gcloud run deploy');
  else {
    const d = deploys[0].text;
    if (!/^gcloud run deploy "\$SERVICE" /.test(d))
      fail('deploy-shape', 'the deploy must name "$SERVICE"');
    if (!/(?<!no-)--allow-unauthenticated\b/.test(d))
      fail(
        'unauthenticated',
        'the app service must be public (--allow-unauthenticated): webhooks need it',
      );
    if (!/--ingress=all(?:\s|$)/.test(d)) fail('ingress', 'the app service needs --ingress=all');
    if (!/--memory=2Gi(?:\s|$)/.test(d)) fail('resources', '--memory=2Gi is required');
    if (!/--cpu=1(?:\s|$)/.test(d)) fail('resources', '--cpu=1 is required');
    const conc = d.match(/--concurrency=(\d+)(?:\s|$)/);
    if (!conc || Number(conc[1]) < 1 || Number(conc[1]) > 40)
      fail('resources', '--concurrency must be given, 1 to 40');
    const probe = d.match(/--startup-probe=(\S+)/);
    if (!probe || !probe[1].includes('httpGet.path=/healthz'))
      fail('probe', 'a startup probe on /healthz is required');
    if (!/--set-secrets="\$SECRET_FLAGS"/.test(d))
      fail('deploy-shape', 'secrets must be mapped with --set-secrets="$SECRET_FLAGS"');
    if (!/--add-cloudsql-instances="\$CONNECTION"/.test(d))
      fail('deploy-shape', 'the Cloud SQL instance must be attached');
  }
  const unauth = count(/(?<!no-)--allow-unauthenticated\b/g);
  if (
    unauth.some((h) => !(h.s.f === 'deploy.sh' && /\bgcloud run deploy\b/.test(h.s.text))) ||
    unauth.length > 1
  )
    fail('unauthenticated', '--allow-unauthenticated is only for the app service deploy, once');

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
  // The image tag carries the commit as well as the tag name (GCP-2).
  if (files['deploy.sh']) {
    const d = files['deploy.sh'];
    const images = d.match(/^IMAGE=.*$/gm) ?? [];
    if (
      images.length !== 1 ||
      !/^IMAGE="[^"]*\/\$\{SERVICE\}:\$\{TAG\}-\$\{COMMIT\}"$/.test(images[0]) ||
      !/^COMMIT="\$\{TAG_COMMIT:0:12\}"$/m.test(d)
    )
      fail(
        'image-tag',
        'the image tag must be ${TAG}-${COMMIT}, with COMMIT the first 12 characters of the tag commit',
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
      for (const m of s.text.matchAll(/--(project|region)(?:=|\s+)(\S?)/g))
        if (m[2] !== '"' && m[2] !== '$')
          fail('literal-project', `${f}:${s.no} gives --${m[1]} a literal value`);
    }
    if (
      !/gcloud auth list --filter=status:ACTIVE/.test(files[f]) ||
      !/^\[ -n "\$ACTIVE_ACCOUNT" \] \|\| die/m.test(files[f])
    )
      fail('account-guard', `${f} must refuse to run when gcloud has no active account`);
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
      fail('secret-names', 'set-secret.sh must allow exactly the nine settable secret names');
  }
  for (const f of ['setup.sh', 'deploy.sh']) {
    const m = (files[f] ?? '').match(/^SECRET_NAMES="([^"]*)"$/m);
    const got = m ? m[1].split(' ').filter(Boolean).sort() : [];
    if (got.join(',') !== [...SECRETS].sort().join(','))
      fail('secret-names', `${f}: SECRET_NAMES must be DATABASE_URL plus the nine settable names`);
  }

  // ---- service.yaml ------------------------------------------------------------------------------
  if (files['service.yaml']) {
    const seen = new Set();
    for (const l of lines['service.yaml']) {
      if (l.comment || l.raw.trim() === '') continue;
      const m = l.raw.match(/^([A-Za-z_][A-Za-z0-9_]*): (?:'([^'\\]*)'|"([^"\\]*)")$/);
      if (!m) {
        fail(
          'value-type',
          `service.yaml:${l.no} must be KEY: 'value' or KEY: "value" (a quoted string, nothing else on the line)`,
        );
        continue;
      }
      const key = m[1];
      const value = m[2] ?? m[3];
      if (seen.has(key)) fail('duplicate-key', `service.yaml:${l.no} repeats ${key}`);
      seen.add(key);
      if (SECRETS.has(key))
        fail(
          'secret-in-env',
          `service.yaml:${l.no} lists ${key}; secrets come from Secret Manager`,
        );
      else if (key === 'UMS_PAYPAL_CONNECT' || key === 'UMS_DB' || key === 'UMS_PUBLIC_ORIGIN') {
        if (
          key === 'UMS_PUBLIC_ORIGIN' &&
          value !== PLACEHOLDER_ORIGIN &&
          !RUN_APP_ORIGIN.test(value)
        )
          fail(
            'origin',
            'UMS_PUBLIC_ORIGIN must be the placeholder or an https run.app origin with no path',
          );
        if (key === 'UMS_DB' && value !== 'postgres') fail('db-kind', 'UMS_DB must be postgres');
      } else if (key in FIXED) {
        if (value !== FIXED[key]) fail('fixed-value', `${key} must be the reviewed fixed value`);
      } else if (CLIENT_PREFIX.test(key))
        fail(
          'public-name',
          `${key} is client-exposed; only NEXT_PUBLIC_UMS_ENV_LABEL may be public`,
        );
      else fail('unknown-name', `${key} is not a name the kit may set`);
    }
    for (const k of Object.keys(FIXED)) if (!seen.has(k)) fail('fixed-value', `${k} is missing`);
    if (!seen.has('UMS_DB')) fail('db-kind', 'UMS_DB with the value postgres is missing');
    if (!seen.has('UMS_PUBLIC_ORIGIN')) fail('origin', 'UMS_PUBLIC_ORIGIN is missing');
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
