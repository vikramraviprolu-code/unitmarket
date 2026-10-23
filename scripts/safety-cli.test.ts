// The pnpm safety:* entry points (review 4 M11): they run, print no secret, and refuse without a terminal.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const run = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      join(REPO_ROOT, 'scripts/lib/ts-register.mjs'),
      join(REPO_ROOT, 'scripts/safety-cli.mjs'),
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
      env: {
        UMS_SESSION_SECRET: S1,
        UMS_APPROVAL_SECRET: ['Zr5tB8nKd2Vw', 'Xq7LmC4yHj9PgF3sEa6U'].join(''),
        UMS_LINK_SECRET: ['Jd4wN7xQk2Zc', 'R9vTb5LmY8hGp3FsAe6U'].join(''),
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

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
});
