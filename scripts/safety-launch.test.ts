// BU-6 (coordinator decision, option a): the operator commands run in a plain Node process that
// registers the TypeScript hooks in-process, so process.execArgv stays free of --import, --require
// and --conditions. In sandbox mode the config guard refuses those flags (transport_env_override),
// and the old launcher passed --import, so safety:approve, resume, status and stop could not run
// against a sandbox config. The guard itself is unchanged and still fail-closed: this proves both.
// Fake placeholders only; each child's environment is built by hand and never inherits the caller's.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1UQm7v';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6UZr5t';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6UJd4w';
const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const OPERATOR = ['safety:status', 'safety:stop', 'safety:approve', 'safety:resume'];

function sandboxEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  return {
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: 'on',
    UMS_OUTBOUND_APPROVAL_REF: 'D-000',
    PAYPAL_CLIENT_ID: ['placeholder', 'client', 'id'].join('-'),
    PAYPAL_CLIENT_SECRET: ['placeholder', 'client', 'secret'].join('-'),
    UMS_SESSION_SECRET: S1,
    UMS_APPROVAL_SECRET: S2,
    UMS_LINK_SECRET: S3,
    UMS_DB: 'pglite-disk',
    UMS_PGLITE_DIR: data,
    ...extra,
  };
}

/** The node arguments of a package.json script, as the script string spells them; a repo path is made absolute because the child runs in a temp folder. */
function nodeArgs(script: string, rest: string[]): string[] {
  const m = /^node\s+(.*)$/.exec(script);
  if (m === null) throw new Error(`not a plain node command: ${script}`);
  const words = (m[1] as string)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.startsWith('scripts/') ? join(REPO_ROOT, w) : w));
  return [...words, ...rest];
}

describe('the package.json operator scripts', () => {
  it.each(OPERATOR)(
    '%s is a plain node command: no preload, loader, conditions or NODE_OPTIONS',
    (name) => {
      const cmd = pkg.scripts[name] as string;
      expect(cmd).toMatch(/^node\b/);
      expect(cmd).toContain('scripts/safety-cli.mjs');
      expect(cmd).not.toMatch(
        /--import|--require|\s-r\s|--loader|--conditions|NODE_OPTIONS|ts-register/,
      );
    },
  );
  it('owner:secrets and sandbox:conformance follow the same rule', () => {
    for (const name of ['owner:secrets', 'sandbox:conformance']) {
      const cmd = pkg.scripts[name] as string;
      expect(cmd, name).toMatch(/^node\b/);
      expect(cmd, name).not.toMatch(
        /--import|--require|--loader|--conditions|NODE_OPTIONS|ts-register/,
      );
    }
  });
});

describe('the status command against a fake sandbox config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-launch-'));
  tmps.push(dir);
  const args = nodeArgs(pkg.scripts['safety:status'] as string, []).map((a) =>
    a.startsWith('--env-file') ? '--env-file-if-exists=/nonexistent/.env.local' : a,
  );
  const r = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: sandboxEnv(dir),
  });
  const out = `${r.stdout}${r.stderr}`;
  it('runs without the boot refusal', () => {
    expect(out).not.toContain('boot refused');
    expect(out).not.toContain('transport_env_override');
    expect(r.status).toBe(0);
    expect(out).toContain('mode=sandbox');
    expect(out).toContain('switch paypal_outbound=off');
  });
  it('and prints no credential or secret', () => {
    for (const v of ['placeholder-client-id', 'placeholder-client-secret', S1, S2, S3])
      expect(out).not.toContain(v);
  });
});

describe('the in-process helper keeps process.execArgv free of the flagged options', () => {
  it('a process started the way the scripts start has an empty execArgv once the hooks are registered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-launch-'));
    tmps.push(dir);
    const probe = join(dir, 'probe.mjs');
    writeFileSync(
      probe,
      [
        `import { registerTs } from ${JSON.stringify(join(REPO_ROOT, 'scripts/lib/register-ts.mjs'))};`,
        `registerTs();`,
        `const { loadConfigFromProcess } = await import(${JSON.stringify(join(REPO_ROOT, 'packages/config/src/index.ts'))});`,
        `const r = loadConfigFromProcess();`,
        `console.log(JSON.stringify({ execArgv: process.execArgv, ok: r.ok, err: r.ok ? null : r.error.code, nodeOptions: process.env.NODE_OPTIONS ?? null }));`,
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [probe], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: sandboxEnv(dir),
    });
    const j = JSON.parse(r.stdout.trim().split('\n').pop() as string) as {
      execArgv: string[];
      ok: boolean;
      err: string | null;
      nodeOptions: string | null;
    };
    expect(j.execArgv).toEqual([]);
    expect(j.nodeOptions).toBeNull();
    expect(j.ok).toBe(true);
  }, 90_000);
  it('registering twice (the old --import launcher plus the new helper) is harmless but still refused in sandbox mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-launch-'));
    tmps.push(dir);
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        join(REPO_ROOT, 'scripts/lib/ts-register.mjs'),
        join(REPO_ROOT, 'scripts/safety-cli.mjs'),
        'status',
      ],
      { cwd: dir, encoding: 'utf8', timeout: 120_000, env: sandboxEnv(dir) },
    );
    expect(`${r.stdout}${r.stderr}`).toContain('transport_env_override');
    expect(r.status).toBe(78);
  }, 150_000);
});

describe('the guard is unchanged: an added flag or NODE_OPTIONS is still refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-launch-'));
  tmps.push(dir);
  const noop = join(dir, 'noop.mjs');
  writeFileSync(noop, 'export {};\n');
  const base = nodeArgs(pkg.scripts['safety:status'] as string, []).filter(
    (a) => !a.startsWith('--env-file'),
  );
  const run = (flags: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...flags, ...base], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
      env: sandboxEnv(dir, env),
    });
  it.each([
    ['--import', [`--import=${noop}`], {}],
    ['--require', [`--require=${noop}`], {}],
    ['--conditions', ['--conditions=custom'], {}],
    ['NODE_OPTIONS', [], { NODE_OPTIONS: '--max-old-space-size=512' }],
  ])('%s', (_n, flags, env) => {
    const r = run(flags as string[], env as Record<string, string>);
    expect(`${r.stdout}${r.stderr}`).toContain('transport_env_override');
    expect(r.status).toBe(78);
  });
});
