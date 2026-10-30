// OPS-PRIV: the pnpm privacy:* entry points refuse without a terminal and in CI, before any database
// is opened, and the package.json wires both subcommands.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

// A folder of its own as the working directory: the config guard reads .env.local from there, never the repo's.
const CWD = mkdtempSync(join(tmpdir(), 'sbx-privacy-cwd-'));
afterAll(() => rmSync(CWD, { recursive: true, force: true }));

// An explicit environment: no CI, GITHUB_ACTIONS or AI-session marker unless the test adds one.
const run = (extra: Record<string, string>, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/privacy.mjs'), ...args], {
    cwd: CWD,
    encoding: 'utf8',
    input: '',
    env: { PATH: process.env['PATH'] ?? '', HOME: CWD, ...extra },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe('privacy.mjs entry point', () => {
  it('export and delete refuse without a terminal: exit 1, one line, nothing on stdout', () => {
    for (const cmd of ['export', 'delete']) {
      const r = run({}, cmd, 'buy_x');
      expect(r.status, r.err).toBe(1);
      expect(r.err.trim()).toBe('refused: not a terminal');
      expect(r.out).toBe('');
    }
  }, 90_000);

  it('export and delete refuse in CI', () => {
    for (const cmd of ['export', 'delete']) {
      const r = run({ CI: '1' }, cmd, 'buy_x');
      expect(r.status, r.err).toBe(1);
      expect(r.err.trim()).toBe('refused: CI');
      expect(r.out).toBe('');
    }
  }, 90_000);

  it('an unknown command prints usage and exits 2', () => {
    const r = run({}, 'wat');
    expect(r.status).toBe(2);
    expect(r.err).toContain('usage:');
  }, 90_000);

  it('the root package.json wires privacy:export and privacy:delete', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['privacy:export']).toContain('scripts/privacy.mjs export');
    expect(pkg.scripts['privacy:delete']).toContain('scripts/privacy.mjs delete');
  });
});
