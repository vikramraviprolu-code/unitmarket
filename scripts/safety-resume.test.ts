// BU-2: pnpm safety:resume refuses without a terminal (the child here has no TTY) and prints no secret.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const run = (env: Record<string, string>, ...args: string[]) => {
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
        ...env,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('safety:resume entry point', () => {
  it('refuses without a terminal, with or without CI or an AI marker, and leaves the switch alone', () => {
    for (const env of [{}, { CI: 'true' }, { CLAUDECODE: '1' }]) {
      const r = run(env, 'resume', '--operator', 'op1', '--reason', 'drill');
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('refused');
      expect(r.out).not.toContain(S1);
    }
    const s = run({}, 'status');
    expect(s.out).toContain('switch paypal_outbound=off');
  }, 120_000);
  it('needs --operator and prints usage for resume', () => {
    const r = run({}, 'resume');
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('--operator');
  }, 60_000);
  it('the root package.json wires the script', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['safety:resume']).toContain('scripts/safety-cli.mjs resume');
  });
});
