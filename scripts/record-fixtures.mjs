// pnpm record:fixtures (MVP-B lane B-L3): turns the owner's raw redacted spike output, or a transport
// call log, into sandbox-recording fixtures. Offline: it reads one local JSON file and writes inside
// fixtures/paypal/sandbox-recordings/ only. It opens no connection and reads no PayPal credential.
//
//   node --import ./scripts/lib/ts-register.mjs scripts/record-fixtures.mjs \
//        --input <raw.json> --origin "<where the recording came from>" \
//        [--recorded-at <ISO UTC>] [--synthetic-ids] [--canary-stdin] [--root <repo>]
//   node --import ./scripts/lib/ts-register.mjs scripts/record-fixtures.mjs --self-test
//
// --canary-stdin reads values that must not appear in the output, one per line from stdin (for
// example: printenv NAME_OF_SECRET_VARIABLE | pnpm record:fixtures ... --canary-stdin). The shell, not
// this tool, reads the environment; the values are used for the comparison only and are never
// printed. There is no output-path option: the folder is fixed.
// Exit codes: 0 done, 1 self-test failed, 2 usage or unreadable input, 3 refused (nothing written).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { systemClock } from '../packages/runtime/src/index.ts';
import {
  buildRecordings,
  formatSummary,
  recorderSelfTest,
  writeRecordings,
} from '../packages/transport/src/index.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code) => {
  process.stderr.write(`record-fixtures: ${line}\n`);
  process.exit(code);
};

const KNOWN = new Set([
  'input',
  'origin',
  'recorded-at',
  'synthetic-ids',
  'canary-stdin',
  'root',
  'self-test',
]);
const FLAGS_WITHOUT_VALUE = new Set(['synthetic-ids', 'self-test', 'canary-stdin']);
const args = process.argv.slice(2);
const opt = new Map();
for (let i = 0; i < args.length; i += 1) {
  const a = args[i] ?? '';
  const name = a.startsWith('--') ? a.slice(2) : '';
  if (!KNOWN.has(name)) fail(`unknown argument (see the header of scripts/record-fixtures.mjs)`, 2);
  if (FLAGS_WITHOUT_VALUE.has(name)) opt.set(name, true);
  else {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`--${name} needs a value`, 2);
    opt.set(name, v);
    i += 1;
  }
}

if (opt.get('self-test')) {
  const r = await recorderSelfTest();
  if (!r.ok) {
    for (const f of r.failures) process.stderr.write(`record-fixtures: self-test failed: ${f}\n`);
    process.exit(1);
  }
  say(`record-fixtures: self-test ok (${r.checked} checks)`);
  process.exit(0);
}

const inputPath = opt.get('input');
const origin = opt.get('origin');
if (typeof inputPath !== 'string' || typeof origin !== 'string')
  fail(
    'usage: --input <raw.json> --origin "<text>" [--recorded-at ISO] [--synthetic-ids] [--canary-stdin]',
    2,
  );

let raw;
try {
  if (statSync(inputPath).size > 8 * 1024 * 1024) fail('input is larger than 8 MB', 2);
  raw = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch {
  fail('input is missing or not valid JSON', 2);
}

const canaries = [];
if (opt.get('canary-stdin')) {
  for (const line of readFileSync(0, 'utf8').split(/\r?\n/)) {
    const v = line.trim();
    if (v.length === 0) continue;
    if (v.length < 4) fail('a canary value is too short to compare safely', 2);
    canaries.push(v);
  }
  if (canaries.length === 0) fail('--canary-stdin received no values', 2);
}

const root = resolve(String(opt.get('root') ?? REPO));
const prettierConfig = (await prettier.resolveConfig(join(REPO, 'fixtures', 'x.json'))) ?? {};
const built = await buildRecordings(raw, {
  recorded_at: String(opt.get('recorded-at') ?? systemClock().now().toISOString()),
  origin,
  synthetic_ids: opt.get('synthetic-ids') === true,
  canaries,
  format: (json) => prettier.format(json, { ...prettierConfig, parser: 'json' }),
});
if (!built.ok)
  fail(`refused (${built.refusal.code}) at ${built.refusal.where}; nothing written`, 3);

const written = await writeRecordings(root, built.files, { canaries });
if (!written.ok)
  fail(`refused (${written.refusal.code}) at ${written.refusal.where}; nothing written`, 3);

say(formatSummary(built.summary));
for (const n of written.written) say(`  wrote fixtures/paypal/sandbox-recordings/${n}`);
say('  updated fixtures/paypal/index.json (sha256 per file)');
if (existsSync(join(root, 'fixtures', 'INDEX.json'))) {
  const r = spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'check-fixtures.mjs'), '--root', root, '--write-index'],
    { encoding: 'utf8' },
  );
  say(
    r.status === 0
      ? '  updated fixtures/INDEX.json'
      : '  fixtures/INDEX.json: run check:fixtures -- --write-index',
  );
}
say('next: read the files, then corepack pnpm check:fixtures and the transport contract tests');
