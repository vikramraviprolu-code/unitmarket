// Log scan (nfr.md OBS-2, P7; MVP-B lane B-L7, acceptance B-09). Looks through captured server log
// lines and provider_calls rows for (1) seeded strings that must never be emitted (a test plants a
// token and an email, then proves they are gone) and (2) anything shaped like a secret. It never
// prints a matched value: a finding carries the rule name, the line number and the length only, so
// the report cannot leak what it found. The scanner proves itself first: selfTest() plants one
// canary per rule in a dirty fixture and requires every canary to be found and a clean fixture to
// pass, so a scanner that has stopped seeing things fails loudly.
//
//   node scripts/log-scan.mjs --self-test
//   node scripts/log-scan.mjs --log <file> [--rows <json file>] [--seed <text>]...
//
// Exit 0 clean, 1 findings (or self-test failure), 2 bad arguments. Reads files only; no network.
import { readFileSync } from 'node:fs';

/** Secret-shaped values. A hashed email ("sha256:" + 12 hex) and "[redacted]" are the allowed forms. */
export const SHAPES = [
  { name: 'bearer_token', re: /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/-]{8,}=*/i },
  { name: 'basic_auth', re: /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}/i },
  { name: 'paypal_access_token', re: /A21AA[A-Za-z0-9_-]{20,}/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'secret_assignment',
    re: /(?:secret|token|password|passcode|assertion|api[_-]?key)[\w-]*["']?\s*[:=]\s*["']?(?!\[redacted\]|null\b|true\b|false\b|undefined\b|none\b)[^\s"',;&})\]]{6,}/i,
  },
  {
    name: 'email_address',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  },
  {
    name: 'cloud_or_vcs_key',
    re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b/,
  },
  {
    name: 'opaque_long_string',
    re: /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/,
  },
];

const variantsOf = (seed) => {
  const s = String(seed);
  return [
    ...new Set([
      s.toLowerCase(),
      encodeURIComponent(s).toLowerCase(),
      Buffer.from(s).toString('base64').replace(/=+$/, '').toLowerCase(),
    ]),
  ].filter((v) => v.length > 0);
};

/** Findings for one piece of text. A seed shorter than 6 characters is refused: it would match anything. */
export function scanText(text, { seeds = [], where = 'text' } = {}) {
  const found = [];
  const lower = text.toLowerCase();
  seeds.forEach((seed, index) => {
    if (String(seed).length < 6) throw new Error('log-scan: a seed must be at least 6 characters');
    if (variantsOf(seed).some((v) => lower.includes(v))) {
      found.push({ rule: 'seeded_value', seed_index: index, where, length: String(seed).length });
    }
  });
  for (const { name, re } of SHAPES) {
    const m = re.exec(text);
    if (m) found.push({ rule: name, where, length: m[0].length });
  }
  return found;
}

export function scanLines(lines, opts = {}) {
  return lines.flatMap((line, i) =>
    scanText(line, { ...opts, where: `${opts.label ?? 'log'}:${i + 1}` }),
  );
}

/** provider_calls rows (or any row objects): each row is scanned as its JSON text. */
export function scanRows(rows, opts = {}) {
  return rows.flatMap((row, i) =>
    scanText(JSON.stringify(row), { ...opts, where: `${opts.label ?? 'row'}:${i + 1}` }),
  );
}

/** The debug id of a provider call must be kept (OBS-1, OBS-3): how many rows carry one. */
export function countDebugIds(rows) {
  return rows.filter((r) => typeof r.debug_id === 'string' && r.debug_id.length > 0).length;
}

/**
 * Canaries are built at run time from fragments, so this file holds no secret-shaped literal.
 * Returns { ok, missed, false_alarms }.
 */
export function selfTest() {
  const part = (...xs) => xs.join('');
  const seedToken = part('seedtoken', '-', 'canary', '-', '7f3a9c21');
  const seedEmail = part('seeded.user', '@', 'canary-mail', '.example');
  const dirty = {
    seeded_value: `ctx note ${seedToken} end`,
    seeded_value_email: `to=${seedEmail}`,
    bearer_token: part('authorization header Bear', 'er ', 'abcDEF1234567890abcDEF'),
    basic_auth: part('Bas', 'ic ', 'dXNlcjpwYXNzd29yZDEyMw+x'),
    paypal_access_token: part('A21', 'AA', 'x'.repeat(8), 'Y'.repeat(8), '9'.repeat(8)),
    jwt: part('ey', 'Jhbgcioij1', '.', 'eyJzdWIiOiIxMjM0NTY', '.', 'c2lnbmF0dXJl'),
    private_key_block: part('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
    secret_assignment: part('client_', 'secret', '=', 'Zq81xPlain99'),
    email_address: part('someone', '@', 'example', '.org'),
    cloud_or_vcs_key: part('AK', 'IA', 'A'.repeat(16)),
    opaque_long_string: part('Ab1', 'x'.repeat(45)),
  };
  const expected = {
    seeded_value: 'seeded_value',
    seeded_value_email: 'seeded_value',
    bearer_token: 'bearer_token',
    basic_auth: 'basic_auth',
    paypal_access_token: 'paypal_access_token',
    jwt: 'jwt',
    private_key_block: 'private_key_block',
    secret_assignment: 'secret_assignment',
    email_address: 'email_address',
    cloud_or_vcs_key: 'cloud_or_vcs_key',
    opaque_long_string: 'opaque_long_string',
  };
  const missed = [];
  for (const [label, text] of Object.entries(dirty)) {
    const rules = scanText(text, { seeds: [seedToken, seedEmail] }).map((f) => f.rule);
    if (!rules.includes(expected[label])) missed.push(label);
    // the same canary inside a provider_calls-shaped row must also be found
    const rowRules = scanRows([{ operation: 'x', response_redacted: { note: text } }], {
      seeds: [seedToken, seedEmail],
    }).map((f) => f.rule);
    if (!rowRules.includes(expected[label])) missed.push(`${label}@row`);
  }
  const clean = [
    '{"time":"2026-10-22T10:00:00.000Z","level":"info","msg":"dryrun.send","fields":{"operation":"create_order","outcome":"created"}}',
    '{"msg":"x","fields":{"authorization":"[redacted]","access_token":"[redacted]","email":"sha256:0123456789ab"}}',
    'paypal_debug_id=sbxmodel0001 request_id=req_0n31eja83zq8m order_ref=ord_0n31eja83zq8mgv3pbmdjtgswv',
  ];
  const false_alarms = scanLines(clean, { seeds: [seedToken, seedEmail] }).map((f) => f.rule);
  return { ok: missed.length === 0 && false_alarms.length === 0, missed, false_alarms };
}

function main() {
  const argv = process.argv.slice(2);
  const all = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
  const st = selfTest();
  if (!st.ok) {
    process.stderr.write(
      `log-scan: self-test failed, missed=[${st.missed.join(',')}] false_alarms=[${st.false_alarms.join(',')}]\n`,
    );
    process.exit(1);
  }
  if (argv.includes('--self-test')) {
    process.stdout.write('log-scan: self-test ok (every canary found, clean fixture clean)\n');
    process.exit(0);
  }
  const logs = all('--log');
  const rowFiles = all('--rows');
  if (logs.length === 0 && rowFiles.length === 0) {
    process.stderr.write(
      'usage: log-scan.mjs --self-test | --log <file> [--rows <json>] [--seed <text>]...\n',
    );
    process.exit(2);
  }
  const seeds = all('--seed');
  let findings = [];
  for (const f of logs) {
    findings = findings.concat(
      scanLines(readFileSync(f, 'utf8').split('\n').filter(Boolean), { seeds, label: 'log' }),
    );
  }
  for (const f of rowFiles) {
    findings = findings.concat(
      scanRows(JSON.parse(readFileSync(f, 'utf8')), { seeds, label: 'row' }),
    );
  }
  for (const f of findings) {
    process.stdout.write(`finding rule=${f.rule} where=${f.where} length=${f.length}\n`);
  }
  process.stdout.write(
    `log-scan: ${findings.length === 0 ? 'clean' : `${findings.length} finding(s)`}\n`,
  );
  process.exit(findings.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
