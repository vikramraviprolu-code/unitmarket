// Fixture lint (nfr.md MAINT-5): every fixture is labelled, sanitised, hashed and listed.
//
//   node scripts/check-fixtures.mjs [--root <dir>] [--write-index]
//
// Scans every file under <root>/fixtures (INDEX.json excepted) and packages/*/src/**/fixtures/**.
// JSON fixtures get the full check; other file types get the text scan (email, bearer, canary, secret keys). Each fixture must
//  - carry meta.source: docs-example, synthetic or sandbox-recording (architecture section 7, item 7),
//    and sit in the matching folder when its path names one of the three;
//  - hold no email address, no bearer token and no unredacted value under a secret-bearing key
//    (redaction canaries: a value other than "[REDACTED]" or empty fails), and no CANARY_ marker;
//  - appear in fixtures/INDEX.json with its current sha256, and the index lists nothing else.
// --write-index regenerates the index. Offending values are never printed, only file and rule.
// No fixtures directory is a pass (the first fixtures arrive with later lanes).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-fixtures';
const SOURCES = ['docs-example', 'synthetic', 'sandbox-recording'];
const SECRET_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'client_secret',
  'client_id',
  'cookie',
  'set-cookie',
  'passcode',
  'password',
  'passwd',
  'paypal-transmission-sig',
  'paypal-auth-assertion',
  'x-paypal-auth-assertion',
  'x-api-key',
  'payer_id',
  'email_address',
]);
// Review M4: names that carry a secret by shape, whatever the exact spelling. `token_type` and
// similar are not secrets; a key that ENDS in token is.
const SECRET_KEY_SHAPE =
  /secret|password|passwd|passcode|assertion|credential|api[_-]?key|private[_-]?key|(?:^|[_-])token$/;
const isSecretKey = (k) => {
  const lk = k.trim().toLowerCase();
  return SECRET_KEYS.has(lk) || SECRET_KEY_SHAPE.test(lk);
};
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
// Case-insensitive markers; lane 03 fixtures write "[redacted]" and "email-redacted".
const REDACTED = new Set(['', '[redacted]', 'redacted', 'email-redacted', '***']);
// Synthetic payer ids carry this prefix; docs-example fixtures keep PayPal's published example ids.
const SYNTHETIC_ID = /^SBX[A-Z0-9]+$/;

const i = process.argv.indexOf('--root');
const ROOT = resolve(
  i >= 0 && process.argv[i + 1]
    ? process.argv[i + 1]
    : fileURLToPath(new URL('..', import.meta.url)),
);
const FIXTURES = join(ROOT, 'fixtures');
const INDEX = join(FIXTURES, 'INDEX.json');

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (abs !== INDEX && name.toLowerCase() !== 'index.json' && !/^readme(\.md)?$/i.test(name))
      out.push(abs);
  }
  return out;
}
const relFix = (abs) => relative(FIXTURES, abs).split(sep).join('/');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// A string that holds JSON (a recorded body) is parsed and scanned like the document around it.
function jsonInside(v) {
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function scanValues(node, path, found, docsExample = false, depth = 0) {
  if (depth > 20) return;
  if (typeof node === 'string') {
    const inner = jsonInside(node);
    if (inner !== undefined) scanValues(inner, `${path}<json>`, found, docsExample, depth + 1);
    return;
  }
  if (Array.isArray(node))
    return node.forEach((v, k) => scanValues(v, `${path}[${k}]`, found, docsExample, depth + 1));
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const lk = k.trim().toLowerCase();
      const okId = lk === 'payer_id' && (SYNTHETIC_ID.test(v) || docsExample);
      const redacted =
        v === null ||
        v === false ||
        (typeof v === 'string' && REDACTED.has(v.trim().toLowerCase())) ||
        typeof v === 'object';
      if (isSecretKey(k) && !redacted && !okId)
        found.push(`${path}.${k.trim()} holds an unredacted value`);
      scanValues(v, `${path}.${k.trim()}`, found, docsExample, depth + 1);
    }
  }
}

// Plain-text scan for files that are not JSON documents: header lines and key: value pairs.
function scanText(rel, text, problems) {
  if (EMAIL.test(text)) problems.push(`${rel}: contains an email address`);
  if (BEARER.test(text)) problems.push(`${rel}: contains a bearer token`);
  if (text.includes('CANARY_')) problems.push(`${rel}: contains a redaction canary marker`);
  for (const line of text.split('\n')) {
    const m = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?([^"'\s,}]+)/.exec(line);
    if (m && isSecretKey(m[1]) && !REDACTED.has(m[2].toLowerCase()))
      problems.push(`${rel}: ${m[1]} holds an unredacted value`);
  }
}

// Fixture-like files kept next to code: packages/<name>/src/**/fixtures/**.
function codeFixtures() {
  const out = [];
  const pk = join(ROOT, 'packages');
  if (!existsSync(pk)) return out;
  const visit = (dir, inFixtures) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) visit(abs, inFixtures || name === 'fixtures');
      else if (inFixtures) out.push(abs);
    }
  };
  for (const pkgName of readdirSync(pk)) {
    const src = join(pk, pkgName, 'src');
    if (existsSync(src)) visit(src, false);
  }
  return out;
}

function main() {
  if (!existsSync(FIXTURES)) {
    console.log(`${NAME}: ok (no fixtures directory)`);
    return 0;
  }
  const entries = [];
  const problems = [];
  for (const abs of walk(FIXTURES)) {
    const rel = relFix(abs);
    const text = readFileSync(abs, 'utf8');
    entries.push({ path: rel, sha256: sha(text) });
    if (!abs.endsWith('.json')) {
      scanText(rel, text, problems);
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      problems.push(`${rel}: not valid JSON`);
      continue;
    }
    const source = doc?.meta?.source;
    if (typeof source !== 'string') problems.push(`${rel}: meta.source is missing`);
    else if (!SOURCES.includes(source))
      problems.push(`${rel}: meta.source is not one of ${SOURCES.join(', ')}`);
    else {
      const folder = SOURCES.find((s) => `/${rel}`.includes(`/${s}/`));
      if (folder && folder !== source)
        problems.push(`${rel}: meta.source differs from its folder (${folder})`);
    }
    if (EMAIL.test(text)) problems.push(`${rel}: contains an email address`);
    if (BEARER.test(text)) problems.push(`${rel}: contains a bearer token`);
    if (text.includes('CANARY_')) problems.push(`${rel}: contains a redaction canary marker`);
    const found = [];
    scanValues(doc, '$', found, source === 'docs-example');
    for (const f of found) problems.push(`${rel}: ${f}`);
  }
  for (const abs of codeFixtures()) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    scanText(rel, text, problems);
    if (abs.endsWith('.json')) {
      try {
        const found = [];
        scanValues(JSON.parse(text), '$', found, false);
        for (const f of found) problems.push(`${rel}: ${f}`);
      } catch {
        problems.push(`${rel}: not valid JSON`);
      }
    }
  }

  const sourceOf = (p) => {
    if (!p.endsWith('.json')) return null;
    try {
      return JSON.parse(readFileSync(join(FIXTURES, p), 'utf8'))?.meta?.source ?? null;
    } catch {
      return null;
    }
  };
  const indexOf = () =>
    JSON.stringify(
      {
        note: 'Generated by scripts/check-fixtures.mjs --write-index. One entry per fixture file.',
        files: entries.map((e) => ({
          ...e,
          source: sourceOf(e.path),
        })),
      },
      null,
      2,
    ) + '\n';
  if (process.argv.includes('--write-index')) {
    writeFileSync(INDEX, indexOf());
    console.log(`${NAME}: wrote index with ${entries.length} file(s)`);
    // Writing the index is bookkeeping; the lint itself still fails on the next plain run.
    for (const p of problems) console.error(`${NAME}: warning: ${p}`);
    return 0;
  }
  if (!existsSync(INDEX)) {
    if (entries.length > 0) problems.push('fixtures/INDEX.json: index is missing');
  } else {
    let listed = [];
    try {
      listed = JSON.parse(readFileSync(INDEX, 'utf8')).files ?? [];
    } catch {
      problems.push('fixtures/INDEX.json: index is not valid JSON');
    }
    const byPath = new Map(listed.map((f) => [f.path, f.sha256]));
    for (const e of entries) {
      if (!byPath.has(e.path)) problems.push(`${e.path}: not listed in the index`);
      else if (byPath.get(e.path) !== e.sha256) problems.push(`${e.path}: index hash is stale`);
    }
    for (const p of byPath.keys())
      if (!entries.some((e) => e.path === p))
        problems.push(`${p}: listed in the index but missing`);
  }
  if (problems.length === 0) {
    console.log(`${NAME}: ok`);
    return 0;
  }
  for (const p of problems) console.error(`${NAME}: ${p}`);
  console.error(
    `${NAME}: FAILED with ${problems.length} violation(s); index: run --write-index after review`,
  );
  return 1;
}

process.exitCode = main();
