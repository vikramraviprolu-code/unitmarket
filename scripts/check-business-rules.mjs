// BR-10 (UNI-80): fails when RULES_REGISTRY (packages/contracts/src/rules.ts) and the section 3 key
// table of docs/business-rules/configurable-rules-design.md disagree.
//   node --import ./scripts/lib/ts-register.mjs scripts/check-business-rules.mjs [--doc <file>]
// Pure and offline: no network, no clock, no environment. The registry is loaded through the
// ts-register hook, as check:openapi does, because contracts is not built.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_REGISTRY } from '../packages/contracts/src/rules.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const docIdx = args.indexOf('--doc');
const doc =
  docIdx >= 0
    ? resolve(args[docIdx + 1] ?? '')
    : resolve(root, 'docs', 'business-rules', 'configurable-rules-design.md');
const shown = relative(process.cwd(), doc) || doc;

// The design table words the merge column in prose. A phrase outside this table is a problem for
// any row the registry holds, because the script cannot tell what it means.
const MERGE_PROSE = [
  [/^the longer one\b/i, 'max'],
  [/^the lower one\b/i, 'min'],
  [/^seller's setting\b/i, 'seller_wins'],
];

const problems = [];
const fail = (msg) => problems.push(`business rules: ${msg}`);

let text;
try {
  text = readFileSync(doc, 'utf8');
} catch {
  console.error(`business rules: cannot read ${shown}`);
  process.exit(1);
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

// The key table is the first table whose header starts with "Key" and has a "Slice" column.
const lines = text.split(/\r?\n/);
let header = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].trim().startsWith('|')) continue;
  const h = cells(lines[i]).map((c) => c.toLowerCase());
  if (h[0] === 'key' && h.includes('slice')) {
    header = i;
    break;
  }
}
if (header < 0) {
  console.error(`business rules: ${shown} has no key table with a Slice column`);
  process.exit(1);
}
const cols = cells(lines[header]).map((c) => c.toLowerCase());
const col = (name) => cols.findIndex((c) => c === name || c.startsWith(name));
const idx = {
  key: 0,
  def: col('default'),
  range: col('safe range'),
  merge: col('when buyer and seller'),
  slice: col('slice'),
};
if (Object.values(idx).some((i) => i < 0)) {
  console.error(
    `business rules: ${shown} key table lacks a Key, Default, Safe range, merge or Slice column`,
  );
  process.exit(1);
}

const rows = new Map();
for (let i = header + 2; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
  const c = cells(lines[i]);
  const key = (c[idx.key] ?? '').replace(/`/g, '');
  if (key) rows.set(key, c);
}

for (const [key, def] of Object.entries(RULES_REGISTRY)) {
  const c = rows.get(key);
  if (!c) {
    fail(`${key} is in the registry but missing from ${shown}`);
    continue;
  }
  const slice = c[idx.slice] ?? '';
  if (!/^BR-\d+$/.test(slice)) {
    fail(`${key} is in the registry but its Slice is "${slice}", expected a lane id such as BR-1`);
  }
  const dflt = /^(\d+)\b/.exec(c[idx.def] ?? '');
  if (!dflt || Number(dflt[1]) !== def.default) {
    fail(`${key} default is "${c[idx.def]}" in the document but ${def.default} in the registry`);
  }
  const range = /^(\d+)\.\.(\d+)/.exec(c[idx.range] ?? '');
  if (!range || Number(range[1]) !== def.min || Number(range[2]) !== def.max) {
    fail(
      `${key} safe range is "${c[idx.range]}" in the document but ${def.min}..${def.max} in the registry`,
    );
  }
  const prose = c[idx.merge] ?? '';
  const hit = MERGE_PROSE.find(([re]) => re.test(prose));
  if (!hit) {
    fail(`${key} merge phrase "${prose}" is not one the check understands`);
  } else if (hit[1] !== def.merge) {
    fail(`${key} merge is "${prose}" (${hit[1]}) in the document but ${def.merge} in the registry`);
  }
}

for (const [key, c] of rows) {
  if (key in RULES_REGISTRY) continue;
  const slice = c[idx.slice] ?? '';
  if (slice !== 'later') {
    fail(
      `${key} is in ${shown} but not in the registry, and its Slice is "${slice}", expected "later"`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`business rules: ${Object.keys(RULES_REGISTRY).length} keys in step`);
