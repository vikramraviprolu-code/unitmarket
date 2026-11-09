// TEST-TIERS: run only the regression a change needs, plus one integrated gate.
//
//   node scripts/test-tier.mjs --tier t1|t2|gate|full [--plan] [--json] [--files a,b] [--base <ref>]
//                              [--group static|tests|e2e] [--shard i/n] [--fail-fast]
//
//   t1    quick: format check of the changed files, lint of the changed code files, typecheck of the
//         touched workspaces, the fast check:* guards, and `vitest related` for the changed files.
//   t2    lane: every test (all six suite kinds, by file-name suffix) in the touched workspaces, plus
//         the same checks (lint covers the touched workspaces).
//   gate  the integrated critical pack from tests/gate.json (money, safety, data integrity, key e2e
//         specs, trace:verify) plus whole-repo format, lint, typecheck and guards.
//   full  the existing `pnpm test`.
//
// Changed files: `git diff --name-only <base>...HEAD`, uncommitted and untracked files. `--files`
// replaces that (tests, reviews). `--plan` prints what a tier would run and runs nothing.
// Reads no environment variable and no secret. Extra variables for a step are passed through
// /usr/bin/env, so this file never touches process.env. Docs: docs/TESTING.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const TIER_LABELS = {
  t1: 'quick',
  t2: 'lane',
  gate: 'integrated gate',
  full: 'full run',
};
const ALIASES = { quick: 't1', lane: 't2' };
const GROUPS = ['static', 'tests', 'e2e'];
const KINDS = ['unit', 'state', 'contract', 'integration', 'adversarial', 'golden'];

const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Files `vitest related` can follow through the import graph (data files tests import included).
const RELATED_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|snap)$/;
// Root files whose change can touch every workspace.
const GLOBAL_RE =
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|eslint\.config\.mjs|vitest\.config\.ts|\.prettierrc\.json|\.prettierignore|\.nvmrc)$/;

// Same roots and exclusions as vitest.config.ts. `scripts` is one level deep only.
const TEST_ROOTS = ['apps', 'domain', 'packages', 'tools', 'tests'];
const NOT_TESTS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)dist\//,
  /^scripts\/__fixtures__\//,
  // Opt-in in vitest.config.ts: it builds and starts the real server.
  /^scripts\/next-start-proof\.integration\.test\.ts$/,
];

// A change that import-graph selection cannot see: these tests run in T1 as well. `gate` adds the
// advice to run the gate.
const TRIGGERS = [
  {
    why: 'a database migration',
    match: /^packages\/db\/migrations\//,
    tests: ['packages/db/src/migration-*.test.ts', 'packages/db/src/schema.state.test.ts'],
    gate: true,
  },
  {
    why: 'a recorded fixture',
    match: /^fixtures\//,
    tests: ['packages/paypal/**/*.test.{ts,tsx}', 'packages/testkit/**/*.test.{ts,tsx}'],
  },
  {
    why: 'the gate pack data',
    match: /^tests\/gate\.json$/,
    tests: ['scripts/test-tier.test.ts'],
  },
];

// Hosting files: the two hosting guards run too (they are not in the fast set).
const HOSTING_RE = /^(render\.yaml|infra\/)/;
const HOSTING_GUARDS = [
  ['hosting', 'check:hosting'],
  ['hosting-gcp', 'check:hosting-gcp'],
];
// Workspaces where a break is a money or safety break: say so, and in T2 also run every test that
// imports the changed files (apps/web and the integrated suites among them).
const CRITICAL_WS = new Set([
  'packages/safety',
  'packages/transport',
  'packages/config',
  'packages/security',
  'packages/paypal',
  'packages/db',
  'domain/payments',
  'domain/approval',
  'domain/ledger',
  'domain/entitlements',
  'domain/trace',
  'domain/receipts',
  'packages/jobs',
]);
// A workspace's own package.json or tsconfig: its typecheck must run although no code changed.
const WS_CONFIG_RE =
  /^((?:apps|domain|packages|tests|tools)\/[^/]+|scripts)\/(?:tsconfig[^/]*\.json|package\.json)$/;

// Public test values, the same ones apps/web/playwright.config.ts gives the app. Not credentials.
const SYNTHETIC_ENV = {
  UMS_MODE: 'offline',
  UMS_SESSION_SECRET: 's-synthetic-test-value-not-a-credential-s',
  UMS_APPROVAL_SECRET: 'a-synthetic-test-value-not-a-credential-a',
  UMS_LINK_SECRET: 'l-synthetic-test-value-not-a-credential-l',
};
const TMP = '@TMP@';

const GUARDS = [
  ['isolation', 'check:isolation'],
  ['no-live-host', 'check:no-live-host'],
  ['secrets-names', 'check:secrets-names'],
  ['fixtures', 'check:fixtures'],
  ['routes', 'check:routes'],
  ['openapi', 'check:openapi'],
];
const GATE_EXTRA_GUARDS = [
  ['business-rules', 'check:business-rules'],
  ['provenance', 'check:provenance'],
  ...HOSTING_GUARDS,
];

/** The workspace directory a file belongs to, or null (docs, root files, CI). */
export function workspaceOf(file) {
  const p = file.split('/');
  if (p[0] === 'apps' && p.length > 2) return `apps/${p[1]}`;
  if (['domain', 'packages', 'tests', 'tools'].includes(p[0]) && p.length > 2) {
    return `${p[0]}/${p[1]}`;
  }
  if (p[0] === 'scripts' && p.length > 1) return 'scripts';
  return null;
}

/** Suite kind of a vitest test file, from its name, as vitest.config.ts picks it; null if none. */
export function kindOfTest(file) {
  if (!/\.test\.tsx?$/.test(file)) return null;
  const p = file.split('/');
  if (p[0] === 'scripts') {
    if (p.length !== 2) return null;
  } else if (!TEST_ROOTS.includes(p[0])) {
    return null;
  }
  if (NOT_TESTS.some((re) => re.test(file))) return null;
  const m = file.match(/\.(state|contract|integration|adversarial|golden)\.test\.tsx?$/);
  return m ? m[1] : 'unit';
}

/** Glob to RegExp: ** crosses folders, * and ? stay inside one, {a,b} alternates. */
export function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
      depth += 1;
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth -= 1;
    } else if (c === ',' && depth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Files matching any include glob and no exclude glob, in the order given. */
export function matchGlobs(files, include, exclude = []) {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return files.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
}

/** tests/gate.json, checked for shape. */
export function loadGate(root = ROOT) {
  const g = JSON.parse(readFileSync(join(root, 'tests/gate.json'), 'utf8'));
  const strings = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string');
  if (!g.vitest || !strings(g.vitest.include) || !strings(g.vitest.exclude ?? [])) {
    throw new Error('tests/gate.json: vitest.include must be a list of globs');
  }
  if (!g.e2e || !strings(g.e2e.specs) || typeof g.e2e.project !== 'string') {
    throw new Error('tests/gate.json: e2e needs a project and a list of specs');
  }
  g.vitest.exclude = g.vitest.exclude ?? [];
  g.shards = Number.isInteger(g.shards) && g.shards > 0 ? g.shards : 4;
  return g;
}

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

/** Every tracked or untracked (not ignored) file that exists. */
export function repoFiles(root = ROOT) {
  return [...new Set(git(root, ['ls-files', '-co', '--exclude-standard']))]
    .filter((f) => existsSync(join(root, f)))
    .sort();
}

/** Files changed against `base`, plus uncommitted and untracked ones. */
export function changedFiles(root = ROOT, base = 'origin/main') {
  const ok = (ref) => {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: root,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  const ref = [base, 'main'].find(ok);
  if (!ref) throw new Error(`no base ref (tried ${base}, main); pass --base <ref> or --files a,b`);
  return [
    ...new Set([
      ...git(root, ['diff', '--name-only', `${ref}...HEAD`]),
      ...git(root, ['diff', '--name-only', 'HEAD']),
      ...git(root, ['ls-files', '--others', '--exclude-standard']),
    ]),
  ].sort();
}

const countKinds = (files) => {
  const byKind = {};
  for (const k of KINDS) {
    const n = files.filter((f) => kindOfTest(f) === k).length;
    if (n > 0) byKind[k] = n;
  }
  return byKind;
};

const run = (...cmd) => ['corepack', 'pnpm', ...cmd];
const vitestCmd = (mode, files, shard) => [
  ...run('exec', 'vitest', ...mode, '--maxWorkers=2', '--passWithNoTests'),
  ...(shard ? [`--shard=${shard}`] : []),
  ...files,
];

function parseShard(shard) {
  if (shard == null) return null;
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1 || Number(m[1]) > Number(m[2])) {
    throw new Error(`bad --shard "${shard}": use i/n with 1 <= i <= n`);
  }
  return shard;
}

/**
 * What a tier runs, as data.
 * @param {{ tier: string, changed?: string[], allFiles?: string[], gate?: any, shard?: string | null,
 *   group?: string | null, exists?: (file: string) => boolean }} o `allFiles` is the repo file list, `exists` tells whether a changed file
 * is still on disk (a deleted file counts for its workspace but is not formatted or linted).
 */
export function buildPlan({
  tier,
  changed = [],
  allFiles = [],
  gate = null,
  shard = null,
  group = null,
  exists = (f) => existsSync(join(ROOT, f)),
}) {
  const t = ALIASES[tier] ?? tier;
  if (!TIER_LABELS[t]) throw new Error(`unknown tier "${tier}": use t1, t2, gate or full`);
  if (group != null && !GROUPS.includes(group)) {
    throw new Error(`unknown --group "${group}": use ${GROUPS.join(', ')}`);
  }
  const sh = parseShard(shard);

  const files = [...new Set(changed)].sort();
  const present = files.filter(exists);
  const codeAll = files.filter((f) => CODE_RE.test(f));
  const code = present.filter((f) => CODE_RE.test(f));
  const workspaces = [...new Set(files.map(workspaceOf).filter(Boolean))].sort();
  const globalChange = files.some((f) => GLOBAL_RE.test(f));
  const testFiles = allFiles.filter((f) => kindOfTest(f));
  const triggered = TRIGGERS.filter((tr) => files.some((f) => tr.match.test(f)));
  const triggerTests = [
    ...new Set(triggered.flatMap((tr) => matchGlobs(testFiles, tr.tests))),
  ].sort();
  const docsOnly =
    workspaces.length === 0 && !globalChange && codeAll.length === 0 && triggerTests.length === 0;

  const notes = [];
  if (docsOnly && files.length > 0)
    notes.push('only documents and data changed: format and guards');
  if (globalChange) {
    notes.push('a root configuration file changed: it can touch every workspace; run the gate');
  }
  if (files.some((f) => f.startsWith('apps/web/e2e/'))) {
    notes.push(
      'an e2e spec changed: T1 and T2 do not run browser specs; run `corepack pnpm --filter @umsbx/web test:e2e <file>` or the gate',
    );
  }
  for (const tr of triggered) {
    notes.push(`${tr.why} changed: its tests run in every tier${tr.gate ? '; run the gate' : ''}`);
  }
  const critical = workspaces.filter((w) => CRITICAL_WS.has(w));
  if (critical.length > 0 && !triggered.some((tr) => tr.gate)) {
    notes.push(`${critical.join(', ')} is in the safety or money layer: run the gate`);
  }

  const steps = [];
  const add = (id, g, label, cmd, extra = {}) => steps.push({ id, group: g, label, cmd, ...extra });
  const guards = (list) => {
    for (const [name, script] of list) add(`guard:${name}`, 'static', script, run(script));
  };
  let tests = null;

  if (t === 'full') {
    add('full', 'tests', 'the whole suite (what pnpm test runs)', run('test'));
  } else if (t === 'gate') {
    if (!gate) throw new Error('the gate needs tests/gate.json');
    add('format', 'static', 'format check, whole repo', run('format:check'));
    add('lint', 'static', 'lint, whole repo', run('lint'));
    add('typecheck', 'static', 'typecheck, whole repo', run('typecheck'));
    guards([...GUARDS, ...GATE_EXTRA_GUARDS]);
    const gateFiles = matchGlobs(testFiles, gate.vitest.include, gate.vitest.exclude).sort();
    tests = { files: gateFiles, byKind: countKinds(gateFiles) };
    add('vitest', 'tests', 'integrated critical pack', vitestCmd(['run'], gateFiles, sh), {
      files: gateFiles,
    });
    // Playwright takes the spec paths as filters; "e2e/" keeps journeys.spec from matching
    // buyer-journeys.spec. The setup spec (sign-in sessions) is named so a file filter keeps it.
    const specs = [
      'e2e/setup.spec.ts',
      ...gate.e2e.specs.map((s) => s.replace(/^apps\/web\//, '')),
    ];
    const dbEnv = { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: TMP };
    // The build gets canary values for every server-side name, and the scan right after it proves none
    // reached a client or server chunk (A-25). The app Playwright starts does not get the canaries.
    add(
      'e2e:build',
      'e2e',
      'build the web app with canary values',
      run('--filter', '@umsbx/web', 'build'),
      { chain: true, canaryEnv: true },
    );
    add('e2e:bundle', 'e2e', 'scan the build for secrets', run('check:bundle'), { chain: true });
    add(
      'e2e:run',
      'e2e',
      'key browser specs on the dry run',
      run(
        '--filter',
        '@umsbx/web',
        'exec',
        'playwright',
        'test',
        `--project=${gate.e2e.project}`,
        ...specs,
      ),
      { chain: true, env: dbEnv, files: specs },
    );
    add(
      'e2e:trace-verify',
      'e2e',
      'trace:verify on the journal the browser run wrote',
      run('trace:verify'),
      {
        chain: true,
        env: { ...SYNTHETIC_ENV, ...dbEnv },
      },
    );
  } else {
    // t1 and t2
    if (present.length > 0) {
      add(
        'format',
        'static',
        'format check of the changed files',
        run('exec', 'prettier', '--check', '--ignore-unknown', ...present),
      );
    }
    const lintTargets = globalChange
      ? ['.']
      : t === 't1'
        ? code
        : [
            ...new Set([
              ...codeAll.map(workspaceOf).filter(Boolean),
              ...code.filter((f) => !workspaceOf(f)),
            ]),
          ].sort();
    if (lintTargets.length > 0) {
      add(
        'lint',
        'static',
        t === 't1' ? 'lint of the changed code files' : 'lint of the touched workspaces',
        run('exec', 'eslint', '--max-warnings', '0', '--no-warn-ignored', ...lintTargets),
      );
    }
    if (globalChange) {
      add('typecheck', 'static', 'typecheck, whole repo', run('typecheck'));
    } else {
      const wsConfig = files.filter((f) => WS_CONFIG_RE.test(f)).map(workspaceOf);
      const wsCode = [
        ...new Set([...codeAll.map(workspaceOf), ...wsConfig].filter(Boolean)),
      ].sort();
      const pkgs = wsCode.filter((w) => w !== 'scripts');
      if (pkgs.length > 0) {
        add(
          'typecheck',
          'static',
          'typecheck of the touched workspaces',
          run(...pkgs.flatMap((w) => ['--filter', `./${w}`]), '--if-present', 'typecheck'),
        );
      }
      if (wsCode.includes('scripts')) {
        add(
          pkgs.length > 0 ? 'typecheck:scripts' : 'typecheck',
          'static',
          'typecheck of scripts',
          run('exec', 'tsc', '-p', 'scripts/tsconfig.json'),
        );
      }
    }
    guards(files.some((f) => HOSTING_RE.test(f)) ? [...GUARDS, ...HOSTING_GUARDS] : GUARDS);

    if (t === 't1') {
      const related = [...new Set([...present.filter((f) => RELATED_RE.test(f)), ...triggerTests])];
      if (related.length > 0) {
        add(
          'vitest',
          'tests',
          'tests that import the changed files',
          vitestCmd(['related', '--run'], related, sh),
          {
            files: related,
          },
        );
      }
    } else {
      const wsTests = testFiles.filter((f) => workspaces.includes(workspaceOf(f)));
      const floor =
        globalChange && gate ? matchGlobs(testFiles, gate.vitest.include, gate.vitest.exclude) : [];
      const picked = [...new Set([...wsTests, ...floor, ...triggerTests])].sort();
      if (picked.length > 0) {
        tests = { files: picked, byKind: countKinds(picked) };
        add(
          'vitest',
          'tests',
          'every test of the touched workspaces',
          vitestCmd(['run'], picked, sh),
          {
            files: picked,
          },
        );
      }
      const related = present.filter((f) => RELATED_RE.test(f));
      if (critical.length > 0 && related.length > 0) {
        add(
          'vitest:dependents',
          'tests',
          'tests that import the changed files (apps/web and the integrated suites included)',
          vitestCmd(['related', '--run'], related, sh),
          { files: related },
        );
      }
    }
  }

  return {
    tier: t,
    label: TIER_LABELS[t],
    changed: files,
    workspaces,
    globalChange,
    docsOnly,
    notes,
    steps: group ? steps.filter((s) => s.group === group) : steps,
    tests,
  };
}

const MAX_LIST = 12;
const shown = (cmd) =>
  cmd.length > 14 ? `${cmd.slice(0, 12).join(' ')} ... (${cmd.length - 12} more)` : cmd.join(' ');

/** Plain text for --plan. */
export function renderPlan(plan) {
  const out = [`tier ${plan.tier} (${plan.label})`];
  if (plan.tier !== 'gate' && plan.tier !== 'full') {
    out.push(`changed files: ${plan.changed.length}`);
    out.push(`workspaces: ${plan.workspaces.length ? plan.workspaces.join(', ') : 'none'}`);
  }
  for (const n of plan.notes) out.push(`note: ${n}`);
  out.push('steps:');
  plan.steps.forEach((s, i) => {
    const names = [...Object.keys(s.env ?? {}), ...(s.canaryEnv ? ['canary values'] : [])];
    const env = names.length > 0 ? ` [env ${names.join(',')}]` : '';
    out.push(`  ${i + 1}. [${s.group}] ${s.id}: ${s.label}${env}`);
    out.push(`       ${shown(s.cmd)}`);
    if (s.files) {
      const head = s.files.slice(0, MAX_LIST).map((f) => `         ${f}`);
      out.push(...head);
      if (s.files.length > MAX_LIST) {
        out.push(`         ... and ${s.files.length - MAX_LIST} more (--json lists all)`);
      }
    }
  });
  if (plan.steps.length === 0) out.push('  (nothing to run)');
  if (plan.tests) {
    const kinds = Object.entries(plan.tests.byKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    out.push(`test files: ${plan.tests.files.length} (${kinds})`);
  }
  return out.join('\n');
}

/**
 * The NAME=value canary lines the build step needs, from `check-bundle-secrets.mjs --print-env`.
 * Throws when that command fails or prints nothing usable.
 * @param {string} [root]
 * @param {(cmd: string, args: string[], o: object) => { status: number | null, stdout?: unknown }} [spawn]
 */
export function canaryEnvLines(root = ROOT, spawn = spawnSync) {
  const c = spawn(process.execPath, ['scripts/check-bundle-secrets.mjs', '--print-env'], {
    cwd: root,
    encoding: 'utf8',
  });
  const lines =
    c.status === 0
      ? String(c.stdout ?? '')
          .split('\n')
          .filter((l) => /^[A-Z_]+=/.test(l))
      : [];
  if (lines.length === 0) {
    throw new Error(
      'no canary values from check-bundle-secrets.mjs --print-env; the bundle scan would test nothing',
    );
  }
  return lines;
}

// Scripts may not read the clock in code (S6), so a step is timed with the system `date`.
const nowNs = () => {
  const r = spawnSync('date', ['+%s%N'], { encoding: 'utf8' });
  return r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? BigInt(r.stdout.trim()) : null;
};
const secsSince = (t0) => {
  const t1 = nowNs();
  return t0 === null || t1 === null ? '-' : `${(Number(t1 - t0) / 1e9).toFixed(1)}s`;
};

/** Run the steps of a plan one after another; returns the process exit code. */
export function runPlan(plan, { failFast = false, root = ROOT } = {}) {
  const tmp = plan.steps.some((s) => s.env) ? mkdtempSync(join(tmpdir(), 'umsbx-tier-')) : null;
  const results = [];
  let broken = new Set();
  try {
    for (const s of plan.steps) {
      if (broken.has(s.group) && s.chain) {
        results.push({ id: s.id, status: 'skipped', time: '-' });
        continue;
      }
      const vars = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v === TMP ? tmp : v}`);
      if (s.canaryEnv) {
        // NAME=value lines for the build, from the bundle guard itself. No lines means no canaries:
        // the scan would then pass on nothing, so the step fails instead.
        try {
          vars.push(...canaryEnvLines(root));
        } catch (e) {
          process.stderr.write(`test-tier: ${e instanceof Error ? e.message : String(e)}\n`);
          results.push({ id: s.id, status: 'FAILED', time: '-' });
          broken = new Set([...broken, s.group]);
          if (failFast) break;
          continue;
        }
      }
      const [prog, ...args] = vars.length ? ['env', ...vars, ...s.cmd] : s.cmd;
      process.stdout.write(`\n== ${s.id}: ${s.label}\n`);
      const t0 = nowNs();
      const r = spawnSync(prog, args, { cwd: root, stdio: 'inherit' });
      const ok = r.status === 0;
      results.push({
        id: s.id,
        status: ok ? 'ok' : 'FAILED',
        time: secsSince(t0),
      });
      if (!ok) {
        broken = new Set([...broken, s.group]);
        if (failFast) break;
      }
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`\n== summary, tier ${plan.tier}\n`);
  for (const r of results)
    process.stdout.write(`  ${r.status.padEnd(8)} ${r.time.padStart(8)}  ${r.id}\n`);
  const red = results.some((r) => r.status === 'FAILED');
  process.stdout.write(red ? `tier ${plan.tier}: RED, no deploy\n` : `tier ${plan.tier}: green\n`);
  return red ? 1 : 0;
}

const USAGE = `usage: node scripts/test-tier.mjs --tier t1|t2|gate|full [--plan] [--json]
         [--files a,b] [--base <ref>] [--group static|tests|e2e] [--shard i/n] [--fail-fast]`;

export function parseArgs(argv) {
  const o = { plan: false, json: false, failFast: false };
  const value = (i, name) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      throw new Error(`${name} needs a value`);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') o.plan = true;
    else if (a === '--json') o.json = true;
    else if (a === '--fail-fast') o.failFast = true;
    else if (a === '--tier') o.tier = value(i++, a);
    else if (a === '--files') o.files = value(i++, a).split(',').filter(Boolean);
    else if (a === '--base') o.base = value(i++, a);
    else if (a === '--group') o.group = value(i++, a);
    else if (a === '--shard') o.shard = value(i++, a);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  return o;
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
    if (o.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!o.tier) throw new Error('--tier is required');
    const changed =
      o.tier === 'full' || o.tier === 'gate'
        ? (o.files ?? [])
        : (o.files ?? changedFiles(ROOT, o.base));
    const plan = buildPlan({
      tier: o.tier,
      changed,
      allFiles: repoFiles(ROOT),
      gate: loadGate(ROOT),
      shard: o.shard,
      group: o.group,
    });
    if (o.plan) {
      process.stdout.write(`${o.json ? JSON.stringify(plan, null, 2) : renderPlan(plan)}\n`);
      return 0;
    }
    return runPlan(plan, { failFast: o.failFast });
  } catch (e) {
    process.stderr.write(`test-tier: ${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
