// Adapted from AIC_Hackathon_UnitMarket/scripts/mutation-checks.mjs at a36ddc0. Owned by SBX.
// The simulation version plants hand-written defects. This version generates mutants itself, so it
// needs no data file: plain Node, no dependency (nfr.md MAINT-4; Stryker would need a new approval).
//
//   node scripts/mutation-checks.mjs [--root <dir>] [--targets a.ts,dir/map-*.ts] [--test-cmd "<cmd>"]
//        [--threshold 80] [--max <mutants per file>] [--timeout <seconds>] [--list]
//
// Operators: relational flip, boolean negation (true/false swap and "!x" to "x"), constant change
// (integer n becomes n+1), removed condition (an "if" condition becomes false).
// For every mutant the source file is rewritten, the test command runs, and the file is restored
// (try/finally and signal handlers). A mutant is KILLED when the command exits non-zero or times out
// and SURVIVED when it exits 0. Exit 0 when the score is at least the threshold, 1 when below it,
// 2 when the baseline suite is red or the arguments are wrong. A target that does not exist yet is
// reported as SKIP; with no target at all the gate passes with a warning.
// Offline: no network, no credential. The test command inherits this process's environment as is.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGETS = [
  'domain/payments/src/match.ts',
  'domain/payments/src/reconcile.ts',
  'domain/access-clock/src/compute.ts',
  'domain/entitlements/src/table.ts',
  'domain/ledger/src/ledger.ts',
  'packages/paypal/src/map-*.ts',
  'packages/paypal/src/money.ts',
];

// --- lexing helpers ------------------------------------------------------------------------
/** Same-length copy of a line with string contents and comments blanked, so operators inside
 * strings and comments are never mutated. `state.block` carries an open block comment across lines. */
export function maskLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (state.block) {
      const end = line.indexOf('*/', i);
      if (end < 0) return out + ' '.repeat(line.length - i);
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      state.block = false;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') return out + ' '.repeat(line.length - i);
    if (c === '/' && line[i + 1] === '*') {
      state.block = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      out +=
        c + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : '');
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const SKIP_LINE =
  /^\s*(import\b|export\s+type\b|export\s+interface\b|type\b|interface\b|declare\b)/;
const REL_FLIP = { '===': '!==', '!==': '===', '<=': '>', '>=': '<', '<': '>=', '>': '<=' };

/** Every mutant of one file's text: { kind, line, start, end, replacement, text }. */
export function mutantsOf(source) {
  const lines = source.split('\n');
  const state = { block: false };
  const out = [];
  let offset = 0;
  lines.forEach((line, idx) => {
    const lineStart = offset;
    offset += line.length + 1;
    const masked = maskLine(line, state);
    if (masked.trim() === '' || SKIP_LINE.test(line)) return;
    const add = (kind, s, e, replacement) =>
      out.push({
        kind,
        line: idx + 1,
        start: lineStart + s,
        end: lineStart + e,
        replacement,
        text: line.trim(),
      });
    for (const m of masked.matchAll(/===|!==|<=|>=|(?<=\s)<(?=\s)|(?<=\s)>(?=\s)/g))
      add('relational', m.index, m.index + m[0].length, REL_FLIP[m[0]]);
    for (const m of masked.matchAll(/\b(true|false)\b/g))
      add('boolean', m.index, m.index + m[0].length, m[0] === 'true' ? 'false' : 'true');
    for (const m of masked.matchAll(/!(?=[A-Za-z_(])/g)) add('negation', m.index, m.index + 1, '');
    for (const m of masked.matchAll(/(?<![\w.$])\d+(?![\w.])/g))
      add('constant', m.index, m.index + m[0].length, String(Number(m[0]) + 1));
    const cond = /^(\s*(?:\}\s*else\s+)?if\s*)\(/.exec(masked);
    if (cond) {
      const open = cond[1].length;
      let depth = 0;
      for (let j = open; j < masked.length; j++) {
        if (masked[j] === '(') depth += 1;
        if (masked[j] === ')' && --depth === 0) {
          if (masked.slice(open + 1, j).trim() !== 'false')
            add('removed-condition', open + 1, j, 'false');
          break;
        }
      }
    }
  });
  return out;
}

/** Evenly spaced deterministic sample of at most `max` mutants. */
export function sample(list, max) {
  if (list.length <= max) return list;
  const picked = [];
  for (let i = 0; i < max; i++) picked.push(list[Math.floor((i * list.length) / max)]);
  return picked;
}

// --- targets -------------------------------------------------------------------------------
export function expandTargets(root, patterns) {
  const found = [];
  const missing = [];
  for (const p of patterns) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    const dir = join(root, p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
    if (!base.includes('*')) {
      (existsSync(join(root, p)) ? found : missing).push(p);
      continue;
    }
    const re = new RegExp(`^${base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const hits = existsSync(dir)
      ? readdirSync(dir).filter((n) => re.test(n) && !/\.test\./.test(n))
      : [];
    if (hits.length === 0) missing.push(p);
    for (const h of hits.sort())
      found.push(p.includes('/') ? `${p.slice(0, p.lastIndexOf('/'))}/${h}` : h);
  }
  return { found, missing };
}

/** Nearest ancestor directory (inside root) holding a package.json; the root itself otherwise. */
function packageDirOf(root, rel) {
  let d = dirname(rel);
  while (d !== '.' && d !== '/') {
    if (existsSync(join(root, d, 'package.json'))) return d;
    d = dirname(d);
  }
  return '.';
}

// --- running -------------------------------------------------------------------------------
function runCommand(cmd, root, timeoutMs) {
  const r = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return { code: r.status ?? 1, timedOut: r.error?.code === 'ETIMEDOUT' };
}

function parseArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    root: get('--root'),
    targets: get('--targets'),
    testCmd: get('--test-cmd'),
    threshold: Number(get('--threshold') ?? 80),
    max: Number(get('--max') ?? 60),
    timeout: Number(get('--timeout') ?? 120),
    list: argv.includes('--list'),
  };
}

function main(argv) {
  const opt = parseArgs(argv);
  const root = resolve(opt.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (
    !Number.isFinite(opt.threshold) ||
    !Number.isFinite(opt.max) ||
    !Number.isFinite(opt.timeout)
  ) {
    console.error('mutation-checks: --threshold, --max and --timeout must be numbers');
    return 2;
  }
  const patterns = opt.targets ? opt.targets.split(',').filter(Boolean) : DEFAULT_TARGETS;
  const { found, missing } = expandTargets(root, patterns);
  for (const m of missing) console.log(`SKIP ${m} (not present yet)`);
  if (found.length === 0) {
    console.log('mutation-checks: no target present; nothing to mutate (pass with warning)');
    return 0;
  }
  const pnpm = 'corepack pnpm';
  const cmdFor = (rel) =>
    (opt.testCmd ?? `${pnpm} exec vitest run --maxWorkers=2 --bail 1 {pkg}`).replace(
      '{pkg}',
      packageDirOf(root, rel),
    );

  const plan = found.map((rel) => {
    const all = mutantsOf(readFileSync(join(root, rel), 'utf8'));
    return { rel, all, chosen: sample(all, opt.max) };
  });
  if (opt.list) {
    for (const t of plan)
      for (const m of t.chosen)
        console.log(`${t.rel}:${m.line}\t${m.kind}\t${m.text}\t=> ${m.replacement || '(removed)'}`);
    return 0;
  }

  const timeoutMs = opt.timeout * 1000;
  const originals = new Map();
  const restore = () => {
    for (const [file, text] of originals) writeFileSync(file, text);
    originals.clear();
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(s, () => {
      restore();
      process.exit(130);
    });

  let killed = 0;
  let total = 0;
  const survivors = [];
  try {
    const baselined = new Set();
    for (const t of plan) {
      const cmd = cmdFor(t.rel);
      if (!baselined.has(cmd)) {
        baselined.add(cmd);
        const base = runCommand(cmd, root, timeoutMs);
        if (base.code !== 0) {
          console.error(
            `mutation-checks: baseline suite is red for ${t.rel} (${cmd}); fix it first`,
          );
          return 2;
        }
      }
      const file = join(root, t.rel);
      const original = readFileSync(file, 'utf8');
      originals.set(file, original);
      let tKilled = 0;
      for (const m of t.chosen) {
        writeFileSync(file, original.slice(0, m.start) + m.replacement + original.slice(m.end));
        const r = runCommand(cmd, root, timeoutMs);
        writeFileSync(file, original);
        total += 1;
        if (r.code !== 0 || r.timedOut) {
          killed += 1;
          tKilled += 1;
        } else {
          survivors.push(`${t.rel}:${m.line} [${m.kind}] ${m.text}`);
        }
      }
      originals.delete(file);
      console.log(`${t.rel}: ${tKilled}/${t.chosen.length} killed (of ${t.all.length} possible)`);
    }
  } finally {
    restore();
  }

  for (const s of survivors) console.log(`SURVIVED ${s}`);
  const score = total === 0 ? 100 : (killed * 100) / total;
  console.log(
    `mutation-checks: score ${score.toFixed(1)} percent (${killed}/${total} killed), threshold ${opt.threshold}`,
  );
  if (score < opt.threshold) {
    console.error('mutation-checks: FAILED below threshold');
    return 1;
  }
  console.log('mutation-checks: ok');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
