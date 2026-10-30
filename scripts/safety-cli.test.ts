// The pnpm safety:* entry points (review 4 M11): they run, print no secret, and refuse without a terminal.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
// A folder of its own as the working directory: the config guard reads .env.local from there, never the repo's.
const CWD = mkdtempSync(join(tmpdir(), 'sbx-cli-cwd-'));
afterAll(() => rmSync(CWD, { recursive: true, force: true }));
const runWith = (extraEnv: Record<string, string>, ...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      join(REPO_ROOT, 'scripts/lib/ts-register.mjs'),
      join(REPO_ROOT, 'scripts/safety-cli.mjs'),
      ...args,
    ],
    {
      cwd: CWD,
      encoding: 'utf8',
      input: '',
      env: {
        UMS_SESSION_SECRET: S1,
        UMS_APPROVAL_SECRET: ['Zr5tB8nKd2Vw', 'Xq7LmC4yHj9PgF3sEa6U'].join(''),
        UMS_LINK_SECRET: ['Jd4wN7xQk2Zc', 'R9vTb5LmY8hGp3FsAe6U'].join(''),
        ...extraEnv,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const run = (...args: string[]) => runWith({}, ...args);

describe('safety CLI entry points', () => {
  it('status lists the switches, paypal_outbound off, and no secret', () => {
    const r = run('status');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('switch paypal_outbound=off');
    expect(r.out).toContain('switch ai_enabled=on');
    expect(r.out).not.toContain(S1);
  });
  it('stop and approve refuse without a terminal', () => {
    for (const args of [
      ['stop', '--operator', 'op1', '--reason', 'drill'],
      ['approve', '--operator', 'op1', '--ref', 'R1'],
    ]) {
      const r = run(...args);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('not_a_tty');
    }
    // SEAL5 item g: two child Node processes, each loading the TypeScript hooks; under a loaded
    // machine the default 30 s was not enough. The assertions are unchanged.
  }, 90_000);
  it('an unknown command prints usage and exits 2', () => {
    expect(run('wat').status).toBe(2);
  });
  it('the root package.json wires the three scripts', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    for (const n of ['safety:status', 'safety:stop', 'safety:approve'])
      expect(pkg.scripts[n]).toContain('scripts/safety-cli.mjs');
  });
  // R5 (CO-9): a live holder of the data directory is one line and exit 1, not a stack trace.
  it('status on a directory held by a live process prints one safety: line and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-cli-lock-'));
    try {
      writeFileSync(
        join(dir, '.ums-open.lock'),
        `${JSON.stringify({ pid: process.pid, host: hostname(), started: '2026-03-04T05:06:07.089Z' })}\n`,
      );
      const r = runWith({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: dir }, 'status');
      expect(r.status, r.out).toBe(1);
      expect(r.out.trim().split('\n')).toEqual([
        `safety: The UnitMarket app (pid ${process.pid}) holds this database. Stop it first, or use the ops page Stop button.`,
      ]);
      expect(r.out).not.toMatch(/\n\s+at /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
  it('status on a directory with an unusable lock prints one safety: line and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-cli-lock-'));
    try {
      writeFileSync(join(dir, '.ums-open.lock'), 'garbage');
      const r = runWith({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: dir }, 'status');
      expect(r.status, r.out).toBe(1);
      expect(r.out.trim().split('\n')).toHaveLength(1);
      expect(r.out).toMatch(/^safety: The database lock file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
