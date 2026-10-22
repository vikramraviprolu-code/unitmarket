// Lane 17 acceptance tests: mutation_detects, bundle_canary, fixtures_check, evidence_writes,
// ci_yaml_safe. Every temporary tree is built inline; nothing here contains a live value.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const script = (name: string) => join(REPO_ROOT, 'scripts', name);
const tmp = () => mkdtempSync(join(tmpdir(), 'sbx-l17-'));
function put(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}
function node(args: string[]) {
  const r = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------- mutation_detects
const MATCH_SRC = `export function matchReadback(got, want) {
  if (got.amount !== want.amount) return 'mismatch';
  if (got.payee !== want.payee) return 'mismatch';
  return 'match';
}
`;
const STRONG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReadback } from './match.mjs';
const base = { amount: 5, payee: 'a' };
test('match', () => assert.equal(matchReadback(base, { ...base }), 'match'));
test('amount differs', () => assert.equal(matchReadback(base, { ...base, amount: 6 }), 'mismatch'));
test('payee differs', () => assert.equal(matchReadback(base, { ...base, payee: 'b' }), 'mismatch'));
`;
// Same suite without the payee case: removing the payee comparison must go unnoticed.
const WEAK_TEST = STRONG_TEST.replace(/test\('payee differs'.*\n/, '');
const mutate = (root: string, extra: string[] = []) =>
  node([
    script('mutation-checks.mjs'),
    '--root',
    root,
    '--targets',
    'match.mjs',
    '--test-cmd',
    'node --test',
    ...extra,
  ]);

describe('mutation_detects', () => {
  it('exits 1 when the suite does not catch a mutant (payee comparison removed)', () => {
    const root = put(tmp(), { 'match.mjs': MATCH_SRC, 'match.test.mjs': WEAK_TEST });
    const r = mutate(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('SURVIVED');
    expect(r.out).toContain('payee');
  });
  it('exits 0 when every mutant is caught, and leaves the source untouched', () => {
    const root = put(tmp(), { 'match.mjs': MATCH_SRC, 'match.test.mjs': STRONG_TEST });
    const r = mutate(root);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/score 100(\.0)? percent/);
    expect(readFileSync(join(root, 'match.mjs'), 'utf8')).toBe(MATCH_SRC);
  });
  it('refuses to run when the baseline suite is red', () => {
    const root = put(tmp(), {
      'match.mjs': MATCH_SRC,
      'match.test.mjs': STRONG_TEST.replace("'match')", "'nope')"),
    });
    expect(mutate(root).status).toBe(2);
  });
  it('lists mutants without running the suite', () => {
    const root = put(tmp(), { 'match.mjs': MATCH_SRC, 'match.test.mjs': WEAK_TEST });
    const r = mutate(root, ['--list']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('relational');
    expect(r.out).toContain('removed-condition');
  });
  it('skips targets that do not exist yet instead of failing', () => {
    const root = put(tmp(), { 'x.txt': 'x' });
    const r = node([script('mutation-checks.mjs'), '--root', root, '--targets', 'nope.ts']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('SKIP');
  });
});

// ---------------------------------------------------------------- bundle_canary
const canaries = () =>
  node([script('check-bundle-secrets.mjs'), '--print-env'])
    .out.split('\n')
    .filter((l) => l.includes('='))
    .map((l) => l.split('=') as [string, string]);
const bundle = (root: string) => node([script('check-bundle-secrets.mjs'), '--root', root]);

describe('bundle_canary', () => {
  it('prints canary env assignments for the build step', () => {
    const list = canaries();
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.map(([n]) => n)).toContain('PAYPAL_CLIENT_SECRET');
    for (const [, v] of list) expect(v.length).toBeGreaterThan(16);
  });
  it('fails when a chunk contains a canary and never prints the value', () => {
    const [name, value] = canaries()[0]!;
    const root = put(tmp(), {
      '.next/static/chunks/app.js': `var a="${value}";`,
      '.next/server/chunks/x.js': 'ok',
    });
    const r = bundle(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(name);
    expect(r.out).not.toContain(value);
  });
  it('fails on a server chunk too', () => {
    const [, value] = canaries()[1]!;
    const root = put(tmp(), { '.next/server/chunks/x.js': `x("${value}")` });
    expect(bundle(root).status).toBe(1);
  });
  it('fails on a NEXT_PUBLIC name other than the env label', () => {
    const pub = 'NEXT_' + 'PUBLIC' + '_';
    const root = put(tmp(), { '.next/static/chunks/a.js': `process.env.${pub}API_KEY` });
    const r = bundle(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${pub}API_KEY`);
  });
  it('passes on a clean build that uses only the env label', () => {
    const pub = 'NEXT_' + 'PUBLIC' + '_UMS_ENV_LABEL';
    const root = put(tmp(), {
      '.next/static/chunks/a.js': `var l=process.env.${pub};`,
      '.next/server/app/page.js': 'console.log(1)',
    });
    const r = bundle(root);
    expect(r.out).toContain('check-bundle-secrets: ok');
    expect(r.status).toBe(0);
  });
  it('fails (exit 2) when there is no build output to scan', () => {
    expect(bundle(tmp()).status).toBe(2);
  });
});

// ---------------------------------------------------------------- fixtures_check
const good = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ meta: { source: 'synthetic', label: 'order created' }, id: 'ORD1', ...extra });
const fx = (root: string) => node([script('check-fixtures.mjs'), '--root', root]);
const indexed = (files: Record<string, string>) => {
  const root = put(tmp(), files);
  const w = node([script('check-fixtures.mjs'), '--root', root, '--write-index']);
  expect(w.status).toBe(0);
  return root;
};

describe('fixtures_check', () => {
  it('passes when there is no fixtures directory yet', () => {
    expect(fx(tmp()).status).toBe(0);
  });
  it('passes on labelled, clean, indexed fixtures', () => {
    const root = indexed({ 'fixtures/paypal/synthetic/a.json': good() });
    const r = fx(root);
    expect(r.out).toContain('check-fixtures: ok');
    expect(r.status).toBe(0);
  });
  it('fails when meta.source is missing', () => {
    const root = indexed({ 'fixtures/paypal/synthetic/a.json': JSON.stringify({ id: 'x' }) });
    const r = fx(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('meta.source');
  });
  it('fails when meta.source is not an allowed label or contradicts the folder', () => {
    const bad = indexed({
      'fixtures/paypal/synthetic/a.json': JSON.stringify({ meta: { source: 'invented' } }),
    });
    expect(fx(bad).status).toBe(1);
    const mismatch = indexed({
      'fixtures/paypal/synthetic/b.json': JSON.stringify({ meta: { source: 'sandbox-recording' } }),
    });
    expect(fx(mismatch).status).toBe(1);
  });
  it('fails on an email address and never prints it', () => {
    const email = 'jane.doe' + '@' + 'example.org';
    const root = indexed({ 'fixtures/paypal/synthetic/a.json': good({ payer: email }) });
    const r = fx(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('email');
    expect(r.out).not.toContain(email);
  });
  it('fails on an unredacted secret-bearing key or bearer token', () => {
    const t1 = indexed({
      'fixtures/paypal/synthetic/a.json': good({ access_token: 'x'.repeat(16) }),
    });
    expect(fx(t1).status).toBe(1);
    const t2 = indexed({
      'fixtures/paypal/synthetic/a.json': good({ header: 'Bearer ' + 'x'.repeat(16) }),
    });
    expect(fx(t2).status).toBe(1);
    const ok = indexed({
      'fixtures/paypal/synthetic/a.json': good({ access_token: '[REDACTED]' }),
    });
    expect(fx(ok).status).toBe(0);
  });
  it('fails when the index is missing, stale or lists a deleted file', () => {
    const root = indexed({ 'fixtures/paypal/synthetic/a.json': good() });
    writeFileSync(join(root, 'fixtures/paypal/synthetic/a.json'), good({ changed: true }));
    expect(fx(root).out).toContain('index');
    expect(fx(root).status).toBe(1);
    const noIndex = put(tmp(), { 'fixtures/paypal/synthetic/a.json': good() });
    expect(fx(noIndex).status).toBe(1);
  });
});

// ---------------------------------------------------------------- evidence_writes
describe('evidence_writes', () => {
  it('writes a report with commands, exit codes and counts, but no env values or long ids', () => {
    const out = tmp();
    const secret = 'ZZsecretvalue' + '987654';
    const longId = 'PAYID' + '1234567890ABC';
    const r = node([
      script('evidence.mjs'),
      '--lane',
      '17',
      '--date',
      '2026-01-02',
      '--out-dir',
      out,
      '--id',
      longId,
      '--step',
      `unit=node -e "console.log('Tests  7 passed (7)'); console.log('${secret}')"`,
      '--step',
      `failing=node -e "console.log('Tests  1 failed | 2 passed (3)'); process.exit(3)"`,
    ]);
    expect(r.status).toBe(1);
    expect(readdirSync(out)).toEqual(['17-2026-01-02.md']);
    const md = readFileSync(join(out, '17-2026-01-02.md'), 'utf8');
    expect(md).toContain('exit 0');
    expect(md).toContain('exit 3');
    expect(md).toMatch(/7 passed/);
    expect(md).toMatch(/1 failed/);
    expect(md).not.toContain(secret);
    expect(md).not.toContain(longId);
    expect(md).toContain(longId.slice(0, 4));
    expect(r.out).not.toContain(secret);
  });
  it('exits 0 and marks PASS when every step passes', () => {
    const out = tmp();
    const r = node([
      script('evidence.mjs'),
      '--lane',
      '17',
      '--date',
      '2026-01-02',
      '--out-dir',
      out,
      '--step',
      `ok=node -e "console.log('Tests  2 passed (2)')"`,
    ]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, '17-2026-01-02.md'), 'utf8')).toContain('PASS');
  });
  it('requires --lane', () => {
    expect(node([script('evidence.mjs')]).status).toBe(2);
  });
});

// ---------------------------------------------------------------- ci_yaml_safe, templates, scripts
describe('ci_yaml_safe', () => {
  const yml = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  it('has read-only permissions, no secrets reference and a frozen lockfile', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(yml).not.toMatch(/\$\{\{\s*secrets\./);
    expect(yml).toContain('pnpm install --frozen-lockfile');
    expect(yml).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
  });
  it('has the lane jobs, with mutation and bundle manual only', () => {
    for (const job of ['lint-type', 'tests', 'checks', 'mutation', 'bundle'])
      expect(yml).toMatch(new RegExp(`^ {2}${job}:`, 'm'));
    expect(yml).toMatch(/mutation:[\s\S]*?if: github\.event_name == 'workflow_dispatch'/);
    expect(yml).toMatch(/bundle:[\s\S]*?if: github\.event_name == 'workflow_dispatch'/);
    expect(yml).toContain('pnpm audit --prod');
  });
  it('deploys nothing and pushes nothing', () => {
    expect(yml).not.toMatch(/deploy|git push|--publish/i);
  });
});

describe('root scripts and templates', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  it('exposes the lane scripts', () => {
    for (const s of ['mutation', 'check:bundle', 'check:fixtures', 'evidence'])
      expect(pkg.scripts[s]).toBeTruthy();
    expect(pkg.scripts.ci).toContain('check:fixtures');
  });
  it('gate report template has severities, verdicts and the control checklist', () => {
    const t = readFileSync(join(REPO_ROOT, 'docs/evidence/TEMPLATE-gate-report.md'), 'utf8');
    for (const s of [
      'Critical',
      'High',
      'Medium',
      'Low',
      'Issue',
      'Risk',
      'Impact',
      'Fix',
      'Files',
    ])
      expect(t).toContain(s);
    for (const v of ['APPROVED FOR SANDBOX DEMO', 'APPROVED WITH CONDITIONS', 'NOT APPROVED'])
      expect(t).toContain(v);
    for (const g of ['MVP-A', 'MVP-B', 'MVP-C', 'MVP-D', 'MVP-E', 'MVP-F']) expect(t).toContain(g);
    expect(t).toContain('AI-3');
    expect(t).toContain('gitleaks');
  });
  it('PR template has spec link, evidence block, sanitised ids and reviewer checklist', () => {
    const t = readFileSync(join(REPO_ROOT, 'docs/evidence/TEMPLATE-pr.md'), 'utf8');
    for (const s of ['Spec', 'Evidence', 'Sanitised ids', 'Reviewer checklist'])
      expect(t).toContain(s);
  });
});
