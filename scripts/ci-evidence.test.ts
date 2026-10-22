// Lane 17 acceptance tests: mutation_detects, bundle_canary, fixtures_check, evidence_writes,
// ci_yaml_safe. Every temporary tree is built inline; nothing here contains a live value.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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

// Review L5: a gate that mutated nothing must say so loudly, and a killed run must not leave a mutant.
describe('mutation_safety', () => {
  const run = (root: string, extra: string[] = []) =>
    node([script('mutation-checks.mjs'), '--root', root, ...extra]);
  it('with no target present prints a loud SKIPPED banner and still passes', () => {
    const r = run(put(tmp(), { 'x.txt': 'x' }), ['--targets', 'nope.ts']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('SKIPPED');
    expect(r.out).toContain('NOTHING WAS MUTATED');
  });
  it('with --require-targets and no target present it fails', () => {
    const r = run(put(tmp(), { 'x.txt': 'x' }), ['--targets', 'nope.ts', '--require-targets']);
    expect(r.status).toBe(3);
    expect(r.out).toContain('NOTHING WAS MUTATED');
  });
  it('refuses to run when a target already carries a mutant marker', () => {
    const left = MATCH_SRC.replace("'mismatch'", "'mismatch' /*SBX-MUTANT*/");
    const root = put(tmp(), { 'match.mjs': left, 'match.test.mjs': STRONG_TEST });
    const r = run(root, ['--targets', 'match.mjs', '--test-cmd', 'node --test']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('match.mjs');
    expect(r.out).toMatch(/leftover mutant/i);
    expect(readFileSync(join(root, 'match.mjs'), 'utf8')).toBe(left);
  });
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'restores the source when killed with %s mid-run',
    async (sig) => {
      const root = put(tmp(), { 'match.mjs': MATCH_SRC, 'match.test.mjs': STRONG_TEST });
      const slow = `node -e "if(require('fs').readFileSync('match.mjs','utf8').includes('SBX-MUTANT'))setTimeout(()=>{},15000)"`;
      const child = spawn(
        process.execPath,
        [
          script('mutation-checks.mjs'),
          '--root',
          root,
          '--targets',
          'match.mjs',
          '--test-cmd',
          slow,
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
      const exited = new Promise<void>((res) => child.on('exit', () => res()));
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (readFileSync(join(root, 'match.mjs'), 'utf8').includes('SBX-MUTANT')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(readFileSync(join(root, 'match.mjs'), 'utf8')).toContain('SBX-MUTANT');
      child.kill(sig);
      await exited;
      expect(readFileSync(join(root, 'match.mjs'), 'utf8')).toBe(MATCH_SRC);
    },
    30_000,
  );
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
  // Review M4: shapes the key-name scan of plain JSON used to let through.
  describe('secrets hidden from the plain key scan', () => {
    const rec = (extra: Record<string, unknown>) =>
      JSON.stringify({ meta: { source: 'sandbox-recording', label: 'x' }, id: 'ORD1', ...extra });
    const failing = (files: Record<string, string>) => {
      const r = fx(indexed(files));
      expect(r.status).toBe(1);
      expect(r.out).not.toContain('abcdefghijkl1234');
      return r.out;
    };
    const recPath = 'fixtures/paypal/sandbox-recording/a.json';

    it('a JSON string body holding an access_token fails', () => {
      failing({ [recPath]: rec({ body: JSON.stringify({ access_token: 'abcdefghijkl1234' }) }) });
    });
    it('a doubly encoded JSON string body fails', () => {
      const inner = JSON.stringify({
        nested: JSON.stringify({ refresh_token: 'abcdefghijkl1234' }),
      });
      failing({ [recPath]: rec({ body: inner }) });
    });
    it.each([
      'password',
      'x-paypal-auth-assertion',
      'paypal-auth-assertion',
      'Authorization ',
      ' access_token',
      'id_token',
      'token',
      'x-api-key',
      'client_secret_value',
      'webhook_secret',
    ])('the key %j with a real-looking value fails', (key) => {
      failing({ [recPath]: rec({ [key]: 'abcdefghijkl1234' }) });
    });
    it('the same keys pass when redacted, and token_type is not a secret', () => {
      const ok = indexed({
        [recPath]: rec({
          password: '[redacted]',
          'x-paypal-auth-assertion': '',
          token_type: 'Bearer',
        }),
      });
      expect(fx(ok).status).toBe(0);
    });
    it('other text fixtures under fixtures/ are scanned', () => {
      for (const ext of ['txt', 'md', 'http', 'har', 'yaml']) {
        const body = `Authorization: Bearer ${'abcdefghijkl1234'}\n`;
        failing({
          'fixtures/paypal/synthetic/a.json': good(),
          [`fixtures/paypal/sandbox-recording/raw.${ext}`]: body,
        });
      }
      failing({
        'fixtures/paypal/synthetic/a.json': good(),
        'fixtures/notes.txt': `contact jane${'@'}example.org\n`,
      });
    });
    it('fixture files kept under packages/*/src/**/fixtures are scanned too', () => {
      failing({
        'fixtures/paypal/synthetic/a.json': good(),
        'packages/transport/src/fixtures/rec.json': rec({ access_token: 'abcdefghijkl1234' }),
      });
    });
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
  // Review M5: redaction covers NAME=value, URL userinfo and short ids, and no command is recorded.
  it('redacts env assignments, URL credentials and ids of 7 or more characters', async () => {
    const mod = (await import(pathToFileURL(script('evidence.mjs')).href)) as {
      redact: (t: string) => string;
    };
    const cases: [string, string][] = [
      ['DATABASE_URL=postgres://u:hunter2pass@db.x/y', 'hunter2pass'],
      ['UMS_SESSION_SECRET=Ab+/Cd9=xyZ+12/kk', 'Ab+/Cd9'],
      ['run postgres://admin:s3cretpw@host/db now', 's3cretpw'],
      ['order id PAYID42', 'PAYID42'],
      ['id 1234567', '1234567'],
      ['tok_a1b2c3d4e5', 'a1b2c3d4e5'],
      ['key=abc', 'abc'],
    ];
    for (const [input, leak] of cases) {
      const out = mod.redact(input);
      expect(out, input).not.toContain(leak);
    }
    for (const keep of [
      'lint',
      'format:check',
      'check:no-live-host',
      'typecheck',
      'abcdefghij',
      'a1b2',
    ]) {
      expect(mod.redact(keep)).toBe(keep);
    }
  });
  it('records step names (redacted) and exit codes, never the command text', () => {
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
      `DATABASE_URL step=node -e "console.log('Tests  1 passed (1)')" postgres://u:hunter2pass@db.x/y UMS_SESSION_SECRET=Ab+/Cd9=xyZ+12/kk`,
      '--step',
      'step PAYID1234=node -e "0"',
    ]);
    expect(r.status).toBe(0);
    const md = readFileSync(join(out, '17-2026-01-02.md'), 'utf8');
    for (const leak of ['hunter2pass', 'Ab+/Cd9', 'PAYID1234', 'postgres://', 'console.log'])
      expect(md + r.out).not.toContain(leak);
    expect(md).toContain('exit 0');
    expect(md).not.toMatch(/\| Command \|/);
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
  // Review M6
  it('checkouts do not persist credentials, and the checks job runs routes and provenance', () => {
    const checkouts = yml.match(/uses: actions\/checkout@[^\n]*\n(?: {8,}[^\n]*\n)*/g) ?? [];
    expect(checkouts.length).toBeGreaterThanOrEqual(5);
    for (const c of checkouts) expect(c).toMatch(/persist-credentials: false/);
    const checks = /\n {2}checks:[\s\S]*?(?=\n {2}\w+:\n)/.exec(yml)?.[0] ?? '';
    for (const s of ['check:routes', 'check:provenance', 'check:isolation', 'check:fixtures'])
      expect(checks).toContain(`pnpm ${s}`);
  });
  it('action pins: tags stay, with a TODO that names the SHA verification step', () => {
    expect(yml).toMatch(/TODO\(pin\)/);
    expect(yml).toMatch(/git ls-remote https:\/\/github\.com\/actions\/checkout/);
  });
  it('deploys nothing and pushes nothing', () => {
    expect(yml).not.toMatch(/deploy|git push|--publish/i);
  });
});

describe('root scripts and templates', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  it('exposes the lane scripts', () => {
    for (const s of [
      'mutation',
      'check:bundle',
      'check:fixtures',
      'check:routes',
      'check:provenance',
      'test:e2e',
      'evidence',
    ])
      expect(pkg.scripts[s]).toBeTruthy();
    for (const s of ['check:fixtures', 'check:routes', 'check:provenance'])
      expect(pkg.scripts.ci).toContain(s);
    expect(pkg.scripts.ci).not.toContain('test:e2e');
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
