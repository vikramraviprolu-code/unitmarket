// TEST-TIERS: the tiered test runner maps changed files to what must run, and `--plan` shows it
// without running anything. Everything here is pure (synthetic file lists) except the checks that
// read tests/gate.json against the real file list, so a stale glob fails here and not on the day.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  globToRegExp,
  kindOfTest,
  loadGate,
  matchGlobs,
  renderPlan,
  repoFiles,
  workspaceOf,
} from './test-tier.mjs';
import { REPO_ROOT } from './test-helpers';

const ALL = [
  'docs/TESTING.md',
  'domain/catalogue/src/fee.ts',
  'domain/catalogue/src/fee.test.ts',
  'domain/catalogue/src/create.state.test.ts',
  'domain/catalogue/src/create.adversarial.test.ts',
  'domain/catalogue/src/index.ts',
  'domain/payments/src/payout.state.test.ts',
  'packages/db/migrations/common/0032_x.sql',
  'packages/db/src/migration-0030.state.test.ts',
  'packages/db/src/index.test.ts',
  'packages/db/src/lock.golden.test.ts',
  'packages/db/src/lock.contract.test.ts',
  'scripts/test-tier.test.ts',
  'scripts/__fixtures__/x/a.test.ts',
  'scripts/next-start-proof.integration.test.ts',
];
const here = { exists: () => true, allFiles: ALL };
const ids = (p: { steps: { id: string }[] }) => p.steps.map((s) => s.id);
const GUARDS = [
  'guard:isolation',
  'guard:no-live-host',
  'guard:secrets-names',
  'guard:fixtures',
  'guard:routes',
  'guard:openapi',
];
const step = (p: { steps: { id: string; cmd: string[] }[] }, id: string) =>
  p.steps.find((s) => s.id === id);

describe('workspaceOf', () => {
  it.each([
    ['apps/web/src/a.ts', 'apps/web'],
    ['domain/catalogue/src/fee.ts', 'domain/catalogue'],
    ['packages/db/migrations/common/0032_x.sql', 'packages/db'],
    ['tests/mvp-a/world.ts', 'tests/mvp-a'],
    ['tools/spike-kit/src/spike.ts', 'tools/spike-kit'],
    ['scripts/check-isolation.mjs', 'scripts'],
    ['docs/TESTING.md', null],
    ['tests/gate.json', null],
    ['package.json', null],
    ['.github/workflows/ci.yml', null],
  ])('%s is in %s', (file, ws) => {
    expect(workspaceOf(file)).toBe(ws);
  });
});

describe('kindOfTest follows vitest.config.ts', () => {
  it.each([
    ['domain/a/src/x.test.ts', 'unit'],
    ['domain/a/src/x.property.test.ts', 'unit'],
    ['apps/web/src/x.test.tsx', 'unit'],
    ['domain/a/src/x.state.test.ts', 'state'],
    ['domain/a/src/x.contract.test.ts', 'contract'],
    ['domain/a/src/x.integration.test.ts', 'integration'],
    ['domain/a/src/x.adversarial.test.ts', 'adversarial'],
    ['domain/a/src/x.golden.test.ts', 'golden'],
    ['domain/a/src/x.ts', null],
    ['scripts/__fixtures__/x/a.test.ts', null],
    ['scripts/sub/x.test.ts', null],
    ['scripts/next-start-proof.integration.test.ts', null],
    ['docs/x.test.ts', null],
    ['apps/web/e2e/refund.spec.ts', null],
  ])('%s is %s', (file, kind) => {
    expect(kindOfTest(file)).toBe(kind);
  });
});

describe('globs', () => {
  it('handles **, *, ? and braces', () => {
    expect(globToRegExp('a/**/b.ts').test('a/b.ts')).toBe(true);
    expect(globToRegExp('a/**/b.ts').test('a/x/y/b.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false);
    expect(globToRegExp('a/*.{ts,tsx}').test('a/b.tsx')).toBe(true);
    expect(globToRegExp('a/*.{ts,tsx}').test('a/b.js')).toBe(false);
    expect(globToRegExp('a/?.ts').test('a/bc.ts')).toBe(false);
    expect(globToRegExp('a.b/c').test('aXb/c')).toBe(false);
  });
  it('matchGlobs keeps order and drops excluded files', () => {
    expect(matchGlobs(['a/x.ts', 'a/y.ts', 'b/z.ts'], ['a/*.ts'], ['a/y.ts'])).toEqual(['a/x.ts']);
  });
});

describe('plan: a docs-only change runs only format and the guards', () => {
  for (const tier of ['t1', 't2']) {
    it(`${tier}`, () => {
      const p = buildPlan({ tier, changed: ['docs/TESTING.md'], ...here });
      expect(p.docsOnly).toBe(true);
      expect(p.workspaces).toEqual([]);
      expect(ids(p)).toEqual(['format', ...GUARDS]);
      expect(p.tests).toBeNull();
      const text = renderPlan(p);
      expect(text).toContain('format');
      expect(text).not.toMatch(/vitest|eslint|typecheck/);
    });
  }
});

describe('plan: a catalogue file maps to the catalogue workspace', () => {
  const changed = ['domain/catalogue/src/fee.ts'];
  it('t1 lints the file, typechecks the workspace, runs related tests and the guards', () => {
    const p = buildPlan({ tier: 't1', changed, ...here });
    expect(p.workspaces).toEqual(['domain/catalogue']);
    expect(ids(p)).toEqual(['format', 'lint', 'typecheck', ...GUARDS, 'vitest']);
    expect(step(p, 'lint')?.cmd).toContain('domain/catalogue/src/fee.ts');
    expect(step(p, 'typecheck')?.cmd).toEqual(
      expect.arrayContaining(['--filter', './domain/catalogue']),
    );
    const v = step(p, 'vitest')?.cmd ?? [];
    expect(v).toEqual(expect.arrayContaining(['related', '--run', 'domain/catalogue/src/fee.ts']));
  });
  it('t2 runs every test of the catalogue workspace, of every kind, and no other workspace', () => {
    const p = buildPlan({ tier: 't2', changed, ...here });
    expect(p.tests?.files).toEqual([
      'domain/catalogue/src/create.adversarial.test.ts',
      'domain/catalogue/src/create.state.test.ts',
      'domain/catalogue/src/fee.test.ts',
    ]);
    expect(p.tests?.byKind).toEqual({ unit: 1, state: 1, adversarial: 1 });
    expect(step(p, 'vitest')?.cmd).toContain('run');
    expect(renderPlan(p)).toContain('domain/catalogue');
    expect(renderPlan(p)).not.toContain('domain/payments');
  });
  it('a deleted file still counts for its workspace but is not formatted or linted', () => {
    const p = buildPlan({
      tier: 't1',
      changed,
      allFiles: ALL,
      exists: () => false,
    });
    expect(p.workspaces).toEqual(['domain/catalogue']);
    expect(ids(p)).not.toContain('format');
    expect(ids(p)).not.toContain('lint');
    expect(ids(p)).toContain('typecheck');
  });
});

describe('plan: a migration triggers the packages/db tests', () => {
  const changed = ['packages/db/migrations/common/0032_x.sql'];
  it('t1 runs the migration tests and no lint or typecheck (no code changed)', () => {
    const p = buildPlan({ tier: 't1', changed, ...here });
    expect(p.workspaces).toEqual(['packages/db']);
    expect(ids(p)).toEqual(['format', ...GUARDS, 'vitest']);
    const v = step(p, 'vitest')?.cmd ?? [];
    expect(v).toContain('packages/db/src/migration-0030.state.test.ts');
    expect(v).not.toContain('domain/payments/src/payout.state.test.ts');
  });
  it('t2 runs all packages/db tests', () => {
    const p = buildPlan({ tier: 't2', changed, ...here });
    expect(p.tests?.files).toEqual([
      'packages/db/src/index.test.ts',
      'packages/db/src/lock.contract.test.ts',
      'packages/db/src/lock.golden.test.ts',
      'packages/db/src/migration-0030.state.test.ts',
    ]);
    expect(p.tests?.byKind).toEqual({ unit: 1, contract: 1, golden: 1, state: 1 });
  });
});

describe('plan: root configuration', () => {
  it('lints and typechecks the whole repo and tells the author to run the gate', () => {
    const p = buildPlan({ tier: 't1', changed: ['eslint.config.mjs'], ...here });
    expect(p.globalChange).toBe(true);
    expect(step(p, 'lint')?.cmd).toContain('.');
    expect(step(p, 'typecheck')?.cmd).toEqual(['corepack', 'pnpm', 'typecheck']);
    expect(p.notes.join(' ')).toMatch(/gate/);
  });
  it('the gate data file triggers this test', () => {
    const p = buildPlan({ tier: 't1', changed: ['tests/gate.json'], ...here });
    expect(step(p, 'vitest')?.cmd).toContain('scripts/test-tier.test.ts');
  });
});

describe('plan: full', () => {
  it('is the existing pnpm test and nothing else', () => {
    const p = buildPlan({ tier: 'full', changed: [], ...here });
    expect(p.steps.map((s) => s.cmd)).toEqual([['corepack', 'pnpm', 'test']]);
  });
});

const ALL2 = [
  'apps/web/src/y.state.test.ts',
  'domain/catalogue/src/fee.ts',
  'domain/catalogue/src/fee.test.ts',
  'packages/db/migrations/common/0033_x.sql',
  'packages/db/src/migration-0030.state.test.ts',
  'packages/db/src/schema.state.test.ts',
  'packages/paypal/src/map-order.test.ts',
  'packages/testkit/src/index.test.ts',
  'packages/transport/src/wire.ts',
  'packages/transport/src/wire.test.ts',
  'scripts/test-tier.test.ts',
  'tests/mvp-a/z.integration.test.ts',
];
const here2 = { exists: () => true, allFiles: ALL2 };

describe('plan: hosting files, fixtures, migrations and safety workspaces', () => {
  it('render.yaml and infra/** also run the two hosting guards', () => {
    for (const f of ['render.yaml', 'infra/gcp/cloud.sh']) {
      const p = buildPlan({ tier: 't1', changed: [f], ...here2 });
      expect(ids(p)).toEqual(expect.arrayContaining(['guard:hosting', 'guard:hosting-gcp']));
      expect(step(p, 'guard:hosting')?.cmd).toEqual(['corepack', 'pnpm', 'check:hosting']);
    }
    // Other changes do not pay for them.
    const q = buildPlan({ tier: 't1', changed: ['docs/TESTING.md'], ...here2 });
    expect(ids(q)).not.toContain('guard:hosting');
  });
  it('fixtures/** trigger the paypal and testkit tests', () => {
    const p = buildPlan({ tier: 't1', changed: ['fixtures/paypal/order.json'], ...here2 });
    const v = step(p, 'vitest')?.cmd ?? [];
    expect(v).toContain('packages/paypal/src/map-order.test.ts');
    expect(v).toContain('packages/testkit/src/index.test.ts');
    expect(v).not.toContain('apps/web/src/y.state.test.ts');
  });
  it('any migration also runs the schema test and says to run the gate', () => {
    const p = buildPlan({
      tier: 't1',
      changed: ['packages/db/migrations/common/0033_x.sql'],
      ...here2,
    });
    const v = step(p, 'vitest')?.cmd ?? [];
    expect(v).toContain('packages/db/src/schema.state.test.ts');
    expect(v).toContain('packages/db/src/migration-0030.state.test.ts');
    expect(p.notes.join(' ')).toMatch(/run the gate/);
  });
  it('a safety-layer change says to run the gate and t2 adds the tests that import it', () => {
    const changed = ['packages/transport/src/wire.ts'];
    const t1 = buildPlan({ tier: 't1', changed, ...here2 });
    expect(t1.notes.join(' ')).toMatch(/run the gate/);
    const t2 = buildPlan({ tier: 't2', changed, ...here2 });
    expect(ids(t2)).toEqual(expect.arrayContaining(['vitest', 'vitest:dependents']));
    expect(step(t2, 'vitest:dependents')?.cmd).toEqual(
      expect.arrayContaining(['related', '--run', 'packages/transport/src/wire.ts']),
    );
    // A workspace outside that list does not.
    const c = buildPlan({ tier: 't2', changed: ['domain/catalogue/src/fee.ts'], ...here2 });
    expect(ids(c)).not.toContain('vitest:dependents');
    expect(c.notes.join(' ')).not.toMatch(/run the gate/);
  });
  it('a workspace package.json or tsconfig.json change runs that workspace typecheck', () => {
    const p = buildPlan({
      tier: 't1',
      changed: ['domain/catalogue/package.json', 'packages/transport/tsconfig.json'],
      ...here2,
    });
    expect(step(p, 'typecheck')?.cmd).toEqual(
      expect.arrayContaining(['--filter', './domain/catalogue', './packages/transport']),
    );
    expect(ids(p)).not.toContain('lint');
    const s = buildPlan({ tier: 't1', changed: ['scripts/tsconfig.json'], ...here2 });
    expect(step(s, 'typecheck')?.cmd).toEqual(
      expect.arrayContaining(['tsc', '-p', 'scripts/tsconfig.json']),
    );
  });
});

describe('tests/gate.json against the real repository', () => {
  const gate = loadGate(REPO_ROOT);
  const files = repoFiles(REPO_ROOT);
  it('every include glob still matches a test file, and every e2e spec exists', () => {
    for (const g of gate.vitest.include) {
      expect(matchGlobs(files, [g], []).length, `glob matches nothing: ${g}`).toBeGreaterThan(0);
    }
    for (const s of gate.e2e.specs) expect(existsSync(join(REPO_ROOT, s)), s).toBe(true);
    for (const x of gate.vitest.exclude) expect(files, `stale exclude: ${x}`).toContain(x);
  });
  it('covers money, safety and data integrity in every kind of suite', () => {
    const p = buildPlan({ tier: 'gate', changed: [], allFiles: files, gate });
    const t = p.tests?.files ?? [];
    for (const dir of [
      'packages/safety/',
      'packages/db/',
      'domain/payments/',
      'domain/approval/',
      'domain/ledger/',
      'domain/entitlements/',
      'domain/offer-entry/',
      'domain/discovery/',
      'domain/mandates/',
      'domain/catalogue/',
    ]) {
      expect(
        t.some((f: string) => f.startsWith(dir)),
        dir,
      ).toBe(true);
    }
    // The safety layer (review of PR 79): a gate without these would pass with a broken transport.
    for (const dir of [
      'packages/transport/',
      'packages/config/',
      'packages/security/',
      'packages/paypal/',
      'packages/jobs/',
      'domain/trace/',
      'domain/receipts/',
      'tests/mvp-d/',
      'tests/mvp-c-pg/',
      'scripts/safety-cli',
      'scripts/safety-resume',
      'scripts/safety-launch',
      'scripts/check-no-live-host.test',
      'scripts/trace-verify.state.test',
      'scripts/backup',
      'scripts/restore',
    ]) {
      expect(
        t.some((f: string) => f.startsWith(dir)),
        dir,
      ).toBe(true);
    }
    // packages/db: schema and migrations, not only a few files.
    expect(t).toContain('packages/db/src/schema.state.test.ts');
    expect(t.some((f: string) => /packages\/db\/src\/migration-/.test(f))).toBe(true);
    // All of packages/paypal, not only its refund and payout tests.
    expect(
      t.some((f: string) => f.startsWith('packages/paypal/') && !/refund|payout/.test(f)),
    ).toBe(true);
    expect(t).toContain('apps/web/src/pob-journey.state.test.ts');
    expect(t.some((f: string) => /refund/.test(f))).toBe(true);
    expect(t.some((f: string) => /payout/.test(f))).toBe(true);
    expect(t).not.toContain('tests/mvp-a/app-a20-a22-perf.integration.test.ts');
    expect(Object.keys(p.tests?.byKind ?? {}).sort()).toEqual(
      ['adversarial', 'contract', 'golden', 'integration', 'state', 'unit'].sort(),
    );
    // Stays a subset: the gate is not the full run.
    expect(t.length).toBeLessThan(files.filter((f: string) => kindOfTest(f)).length);
  });
  it('has static, tests and e2e groups; trace:verify runs after the browser specs', () => {
    const p = buildPlan({ tier: 'gate', changed: [], allFiles: files, gate });
    const groups = new Set(p.steps.map((s: { group: string }) => s.group));
    expect([...groups].sort()).toEqual(['e2e', 'static', 'tests']);
    const order = ids(p);
    expect(order.indexOf('e2e:build')).toBeLessThan(order.indexOf('e2e:bundle'));
    expect(order.indexOf('e2e:bundle')).toBeLessThan(order.indexOf('e2e:run'));
    // The client-bundle secret scan is part of the gate, right after the build that feeds it.
    expect(step(p, 'e2e:bundle')?.cmd.join(' ')).toContain('check:bundle');
    expect(order.indexOf('e2e:run')).toBeLessThan(order.indexOf('e2e:trace-verify'));
    expect(step(p, 'e2e:trace-verify')?.cmd.join(' ')).toContain('trace:verify');
    const run = step(p, 'e2e:run')?.cmd ?? [];
    expect(run).toContain('apps/web/e2e/refund.spec.ts'.replace('apps/web/', ''));
    expect(run).toContain('--project=offline');
  });
  it('--group and --shard pick one quarter of the test files', () => {
    const all = buildPlan({ tier: 'gate', changed: [], allFiles: files, gate });
    const p = buildPlan({
      tier: 'gate',
      changed: [],
      allFiles: files,
      gate,
      group: 'tests',
      shard: '1/4',
    });
    expect(ids(p)).toEqual(['vitest']);
    expect(step(p, 'vitest')?.cmd).toContain('--shard=1/4');
    expect(p.tests?.files).toEqual(all.tests?.files);
    expect(() =>
      buildPlan({ tier: 'gate', changed: [], allFiles: files, gate, shard: '5/4' }),
    ).toThrow(/shard/);
  });
});

describe('--plan on the command line', () => {
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/test-tier.mjs'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  it('prints the docs-only plan and runs nothing', () => {
    const r = run('--tier', 't1', '--plan', '--files', 'docs/TESTING.md');
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('tier t1');
    expect(r.out).toContain('format');
    expect(r.out).toContain('check:isolation');
    expect(r.out).not.toMatch(/vitest|eslint/);
  });
  it('--json prints the same plan as data', () => {
    const r = run('--tier', 't2', '--plan', '--json', '--files', 'domain/catalogue/src/fee.ts');
    expect(r.status, r.err).toBe(0);
    const p = JSON.parse(r.out);
    expect(p.workspaces).toEqual(['domain/catalogue']);
    expect(p.tests.files.every((f: string) => f.startsWith('domain/catalogue/'))).toBe(true);
  });
  it('refuses an unknown tier, a missing tier and a bad shard with exit 2', () => {
    expect(run('--tier', 't9', '--plan').status).toBe(2);
    expect(run('--plan').status).toBe(2);
    expect(run('--tier', 'gate', '--plan', '--shard', '0/4').status).toBe(2);
  });
});

describe('wiring', () => {
  const root = (f: string) => readFileSync(join(REPO_ROOT, f), 'utf8');
  it('package.json has test:t1, test:t2 and test:gate; test stays the full run', () => {
    const pkg = JSON.parse(root('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:t1']).toBe('node scripts/test-tier.mjs --tier t1');
    expect(pkg.scripts['test:t2']).toBe('node scripts/test-tier.mjs --tier t2');
    expect(pkg.scripts['test:gate']).toBe('node scripts/test-tier.mjs --tier gate');
    expect(pkg.scripts['test']).toContain('vitest run --maxWorkers=2 --project unit');
  });
  it('ci.yml has a tier input (gate or full, default gate) and no secret or wider permission', () => {
    const y = root('.github/workflows/ci.yml');
    expect(y).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tier:/);
    expect(y).toMatch(/type: choice/);
    expect(y).toMatch(/default: gate/);
    expect(y).toMatch(/options:\s*\n\s+- gate\s*\n\s+- full/);
    expect(y).toContain('permissions:\n  contents: read\n');
    expect(y).not.toMatch(/\$\{\{\s*secrets\./);
    // The gate's test shards run the real-Postgres suites too (they skip without the binaries).
    const shards = y.slice(y.indexOf('gate-tests:'), y.indexOf('gate-e2e:'));
    expect(shards).toContain('UMS_TEST_PG_BIN');
    expect(shards).toContain('initdb');
    expect(y).not.toMatch(/\bdeploy\b\s*:/);
  });
  it('docs/TESTING.md names the three scripts and the go/no-go rule', () => {
    const d = root('docs/TESTING.md');
    for (const s of ['test:t1', 'test:t2', 'test:gate', 'pnpm test']) expect(d).toContain(s);
    expect(d).toMatch(/no deploy/i);
    // No bullet may let a red test pass because only the full run saw it.
    expect(d).not.toMatch(/does not stop a deploy/i);
    expect(d).toMatch(/whatever the tier/i);
    for (const w of ['safety', 'money', 'transport', 'config', 'security']) expect(d).toContain(w);
    expect(d).toContain('UMS_TEST_PG_BIN');
    expect(d).toMatch(/skip/i);
  });
  it('the spec says what --plan lists and how a shard is passed', () => {
    const d = root('docs/specs/test-tiers.md');
    expect(d).toContain('--shard=1/4');
    expect(d).not.toMatch(/lists one quarter/);
  });
});
