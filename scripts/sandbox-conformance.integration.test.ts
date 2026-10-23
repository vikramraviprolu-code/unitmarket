// BU-6: pnpm sandbox:conformance is the only way to run the owner-run suite, and it refuses outside
// a person's terminal. Everything here is offline: the refusals never load anything, and the one
// real run uses obviously fake placeholders, an empty temporary database (so no approval row exists
// and the first call is blocked by the kill switch) and a temporary home directory. No test sets
// UMS_SANDBOX_TESTS=1 with real values; the environment of each child is built by hand and never
// inherits the caller's.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from './test-helpers';
import { ENV_NAMES } from '../packages/config/src/schema';
import { CI_MARKERS, AI_MARKERS, runSandboxConformance } from './sandbox-conformance.mjs';

// UMS_OWN_MERCHANT_ID is read by packages/config from BU-7 on (D-028). Until that lane is merged the
// config does not know the name, the subject has no payee, and the run stops before its first call
// with a different reason. Both are a STOP with no Wire call; once BU-7 is in, the closed lock
// (no approval row, switch off) is what stops it.
const CONFIG_KNOWS_OWN_ID = (ENV_NAMES as readonly string[]).includes('UMS_OWN_MERCHANT_ID');
const STOP_REASON = CONFIG_KNOWS_OWN_ID ? /kill_switch/ : /UMS_OWN_MERCHANT_ID is not set/;

const SCRIPT = join(REPO_ROOT, 'scripts', 'sandbox-conformance.mjs');
const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

function refusalRig(over: {
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  env?: Record<string, string | undefined>;
  homedir?: string;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const run = vi.fn(async () => 0);
  const deps = {
    stdinIsTTY: over.stdinIsTTY ?? true,
    stderrIsTTY: over.stderrIsTTY ?? true,
    env: { UMS_SANDBOX_TESTS: '1', ...(over.env ?? {}) } as Record<string, string | undefined>,
    argv: [] as string[],
    homedir: over.homedir ?? '/nonexistent-home-for-refusal-tests',
    repoRoot: REPO_ROOT,
    say: (l: string) => void out.push(l),
    err: (l: string) => void err.push(l),
    run,
  };
  return { deps, out, err, run };
}

describe('refusals (nothing is loaded, no database is opened, no call is made)', () => {
  const cases: [string, Parameters<typeof refusalRig>[0], string][] = [
    ['stdin is not a terminal', { stdinIsTTY: false }, 'not_a_tty'],
    ['stderr is not a terminal', { stderrIsTTY: false }, 'not_a_tty'],
    ['CI=1', { env: { CI: '1' } }, 'ci_set'],
    ['GITHUB_ACTIONS=true', { env: { GITHUB_ACTIONS: 'true' } }, 'ci_set'],
    ['CLAUDECODE=1', { env: { CLAUDECODE: '1' } }, 'ai_session'],
    ['CLAUDE_CODE_REMOTE=true', { env: { CLAUDE_CODE_REMOTE: 'true' } }, 'ai_session'],
    ['the flag is missing', { env: { UMS_SANDBOX_TESTS: undefined } }, 'flag_missing'],
    ['the flag is 0', { env: { UMS_SANDBOX_TESTS: '0' } }, 'flag_missing'],
    ['the flag is true, not 1', { env: { UMS_SANDBOX_TESTS: 'true' } }, 'flag_missing'],
    ['the flag is " 1"', { env: { UMS_SANDBOX_TESTS: ' 1' } }, 'flag_missing'],
    [
      'the output folder would sit inside the repository',
      { homedir: join(REPO_ROOT, 'x') },
      'output_in_repo',
    ],
  ];
  it.each(cases)('%s', async (_n, o, code) => {
    const r = refusalRig(o);
    const res = await runSandboxConformance(r.deps);
    expect(res.code).toBe(2);
    expect(res.reason).toBe(code);
    expect(r.err.join('\n')).toContain(code);
    expect(r.run).not.toHaveBeenCalled();
  });
  it.each(CI_MARKERS.map((m) => [m]))('every CI marker refuses: %s', async (m) => {
    const r = refusalRig({ env: { [m as string]: '1' } });
    const res = await runSandboxConformance(r.deps);
    expect(res.reason).toBe('ci_set');
    expect(r.run).not.toHaveBeenCalled();
  });
  it.each(AI_MARKERS.map((m) => [m]))('every AI marker refuses: %s', async (m) => {
    const r = refusalRig({ env: { [m as string]: '1' } });
    const res = await runSandboxConformance(r.deps);
    expect(res.reason).toBe('ai_session');
    expect(r.run).not.toHaveBeenCalled();
  });
  it.each([
    [[], undefined],
    [['--only', 'payee-echo'], 'payee-echo'],
  ])('the arguments %j are accepted and reach the run as %s', async (argv, only) => {
    const r = refusalRig({ homedir: join(tmpdir(), 'sbx-none') });
    r.deps.argv = argv as string[];
    const res = await runSandboxConformance(r.deps);
    expect(res).toEqual({ code: 0 });
    expect(r.run).toHaveBeenCalledWith({
      outBase: join(tmpdir(), 'sbx-none', 'unitmarket-sandbox-run'),
      only,
    });
  });
  it.each([
    [['--only']],
    [['--only', 'other']],
    [['payee-echo']],
    [['--only', 'payee-echo', 'extra']],
    [['--only=payee-echo']],
    [['x', 'y']],
    [['--only', 'payee-echo', '--only', 'payee-echo']],
  ])('the arguments %j are refused as bad_args', async (argv) => {
    const r = refusalRig({ homedir: join(tmpdir(), 'sbx-none') });
    r.deps.argv = argv as string[];
    const res = await runSandboxConformance(r.deps);
    expect(res).toEqual({ code: 2, reason: 'bad_args' });
    expect(r.run).not.toHaveBeenCalled();
  });
  it('the marker lists hold the names the lane relies on', () => {
    for (const n of ['CI', 'GITHUB_ACTIONS']) expect(CI_MARKERS).toContain(n);
    for (const n of ['CLAUDECODE', 'CLAUDE_CODE_REMOTE']) expect(AI_MARKERS).toContain(n);
  });
  it('an empty marker value does not refuse', async () => {
    const r = refusalRig({ env: { CI: '', CLAUDECODE: '' }, homedir: join(tmpdir(), 'sbx-none') });
    const res = await runSandboxConformance(r.deps);
    expect(res.reason).toBeUndefined();
    expect(r.run).toHaveBeenCalledTimes(1);
  });
  it('the command refuses without a terminal and says why', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
      env: { UMS_SANDBOX_TESTS: '1' },
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('not_a_tty');
  }, 60_000);
});

describe('the command line', () => {
  it('the root package.json runs the plain entry: no preload, loader or conditions flag, no NODE_OPTIONS', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    const cmd = pkg.scripts['sandbox:conformance'] as string;
    expect(cmd).toContain('scripts/sandbox-conformance.mjs');
    expect(cmd).not.toMatch(/--import|--require|-r |--loader|--conditions|NODE_OPTIONS|--inspect/);
  });
});

// ---- a real run, plain Node, fake config ----

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1UQm7v';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6UZr5t';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6UJd4w';
const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
const FAKE_SECRET = ['placeholder', 'client', 'secret'].join('-');

function driver(dir: string): string {
  const p = join(dir, 'drive.mjs');
  writeFileSync(
    p,
    [
      `import { runSandboxConformance } from ${JSON.stringify(SCRIPT)};`,
      `const home = process.env.HOME;`,
      `const r = await runSandboxConformance({`,
      `  stdinIsTTY: true, stderrIsTTY: true, env: { UMS_SANDBOX_TESTS: '1' }, argv: process.argv.slice(2),`,
      `  homedir: home, repoRoot: ${JSON.stringify(REPO_ROOT)},`,
      `  say: (l) => console.log(l), err: (l) => console.error(l),`,
      `});`,
      `console.log('execArgv=' + JSON.stringify(process.execArgv));`,
      `process.exit(r.code);`,
    ].join('\n'),
  );
  return p;
}

function plainRun(
  extraEnv: Record<string, string> = {},
  flags: string[] = [],
  args: string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-conf-'));
  tmps.push(dir);
  const home = join(dir, 'home');
  const data = join(dir, 'data');
  mkdirSync(home);
  mkdirSync(data);
  const r = spawnSync(process.execPath, [...flags, driver(dir), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    // built by hand: the caller's environment (which may hold real values) is never inherited
    env: {
      HOME: home,
      UMS_MODE: 'sandbox',
      UMS_PAYPAL_CONNECT: 'on',
      UMS_OUTBOUND_APPROVAL_REF: 'D-000',
      UMS_OUTBOUND_SCOPE: 'mvp_b_polling',
      UMS_OWN_MERCHANT_ID: 'SBXOWNMERCH01',
      PAYPAL_CLIENT_ID: FAKE_ID,
      PAYPAL_CLIENT_SECRET: FAKE_SECRET,
      UMS_SESSION_SECRET: S1,
      UMS_APPROVAL_SECRET: S2,
      UMS_LINK_SECRET: S3,
      UMS_DB: 'pglite-disk',
      UMS_PGLITE_DIR: data,
      ...extraEnv,
    },
  });
  return { r, out: `${r.stdout}${r.stderr}`, home, dir };
}

describe('a real run with a fake config and no approval row', () => {
  const run = plainRun();
  it('runs with an empty execArgv and reports the Wire self-check clean', () => {
    expect(run.out).toContain('execArgv=[]');
    expect(run.out).toMatch(/wire self-check: env_override false/);
    expect(run.out).not.toContain('transport_env_override');
  });
  it('stops at the first call with the blocked reason and a non-zero exit', () => {
    expect(run.r.status).toBe(1);
    expect(run.out).toMatch(STOP_REASON);
    expect(run.out).toContain('payee echo: STOP');
  });
  it('writes summary.md and calls.json under the home folder, and names the folder', () => {
    const base = join(run.home, 'unitmarket-sandbox-run');
    const days = readdirSync(base);
    expect(days).toHaveLength(1);
    const folder = join(base, days[0] as string);
    expect(readdirSync(folder).sort()).toEqual(['calls.json', 'summary.md']);
    expect(run.out).toContain(folder);
    const md = readFileSync(join(folder, 'summary.md'), 'utf8');
    expect(md).toMatch(STOP_REASON);
    expect(md).toMatch(/FAIL/);
  });
  it('prints and writes no credential and no secret', () => {
    const base = join(run.home, 'unitmarket-sandbox-run');
    const folder = join(base, readdirSync(base)[0] as string);
    const all = [
      run.out,
      readFileSync(join(folder, 'summary.md'), 'utf8'),
      readFileSync(join(folder, 'calls.json'), 'utf8'),
    ].join('\n');
    for (const v of [FAKE_ID, FAKE_SECRET, S1, S2, S3]) expect(all).not.toContain(v);
    expect(all).not.toContain('SBXOWNMERCH01');
  });
});

describe('fail-closed under an override', () => {
  it.each([
    ['an environment proxy', {}, { HTTPS_PROXY: 'http://proxy.example.invalid:3128' }],
    ['NODE_OPTIONS', {}, { NODE_OPTIONS: '--max-old-space-size=512' }],
  ])('%s: the config refuses, nothing is called, no folder is written', (_n, _f, env) => {
    const run = plainRun(env as Record<string, string>);
    expect(run.r.status).not.toBe(0);
    expect(run.out).toContain('transport_env_override');
    expect(existsSync(join(run.home, 'unitmarket-sandbox-run'))).toBe(false);
  });
  it.each(['--require', '--import', '--conditions'])('node flag %s: the config refuses', (flag) => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-flag-'));
    tmps.push(dir);
    const noop = join(dir, 'noop.mjs');
    writeFileSync(noop, 'export {};\n');
    const arg = flag === '--conditions' ? `${flag}=custom` : `${flag}=${noop}`;
    const run = plainRun({}, [arg]);
    expect(run.r.status).not.toBe(0);
    expect(run.out).toContain('transport_env_override');
    expect(existsSync(join(run.home, 'unitmarket-sandbox-run'))).toBe(false);
  });
  it('the env-file flag of the package.json script is not an override', () => {
    const run = plainRun({}, ['--env-file-if-exists=/nonexistent/.env.local']);
    expect(run.out).not.toContain('transport_env_override');
    expect(run.out).toMatch(/wire self-check: env_override false/);
  });
});

describe('--only payee-echo', () => {
  it('runs the first case alone and still stops on the closed lock', () => {
    const run = plainRun({}, [], ['--only', 'payee-echo']);
    expect(run.out).toContain('payee echo: STOP');
    expect(run.r.status).toBe(1);
  });
});
