// INT-E2E (item E2E.2, F9): scripts/demo-tamper.mjs, the tamper demo for the video. It runs on the in-memory
// database only: any other target exits 2 with one refusal line, before any database module is imported, so
// a Postgres URL is never dialled and a PGlite directory is never created. With UMS_DB unset (the default,
// pglite-memory) it boots the dry-run app in-process, buys one unit inside a trace context, and replays the
// three tamper steps with the in-process verifier: exit 0. Synthetic values only (the three D-058 test
// secrets, the same as scripts/safety-cli.test.ts); nothing reaches a network.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts/demo-tamper.mjs');
const REFUSAL = 'demo-tamper runs on pglite-memory only';
// A folder of its own as the working directory: the config guard reads .env.local from there, never the repo's.
const CWD = mkdtempSync(join(tmpdir(), 'sbx-demo-tamper-cwd-'));
afterAll(() => rmSync(CWD, { recursive: true, force: true }));

const run = (extraEnv: Record<string, string>) => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: CWD,
    encoding: 'utf8',
    input: '',
    timeout: 240_000,
    env: {
      UMS_MODE: 'offline',
      UMS_SESSION_SECRET: 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U',
      UMS_APPROVAL_SECRET: ['Zr5tB8nKd2Vw', 'Xq7LmC4yHj9PgF3sEa6U'].join(''),
      UMS_LINK_SECRET: ['Jd4wN7xQk2Zc', 'R9vTb5LmY8hGp3FsAe6U'].join(''),
      ...extraEnv,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe('demo-tamper.mjs refuses every database but the in-memory one', () => {
  it('UMS_DB=postgres with a loopback URL on port 1: exit 2 with the refusal line, before any database import', () => {
    const r = run({ UMS_DB: 'postgres', DATABASE_URL: 'postgres://demo:demo@127.0.0.1:1/demo' });
    expect(r.status, `${r.out}${r.err}`).toBe(2);
    expect(r.err).toContain(REFUSAL);
    expect(`${r.out}${r.err}`).not.toContain('127.0.0.1:1');
    expect(r.out).not.toContain('tamper');
  }, 60_000);

  it('UMS_DB=pglite-disk at a path that does not exist: exit 2, and the path still does not exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'sbx-demo-tamper-disk-'));
    const dir = join(parent, 'never-created');
    try {
      const r = run({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: dir });
      expect(r.status, `${r.out}${r.err}`).toBe(2);
      expect(r.err).toContain(REFUSAL);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('demo-tamper.mjs with UMS_DB unset (pglite-memory)', () => {
  it('buys one unit, shows each tamper caught and each restore clean, in plain words, and exits 0', () => {
    const r = run({});
    expect(r.status, `${r.out}${r.err}`).toBe(0);
    const out = r.out;
    expect(out).toMatch(/database: pglite-memory/);
    expect(out).toMatch(/one purchase made/i);
    expect(out).toMatch(/step 1/i);
    expect(out).toMatch(/drift ledger_entries \S+ amount_minor/);
    expect(out).toMatch(/step 2/i);
    expect(out).toMatch(/step 3/i);
    expect(out).toMatch(/ord:\S+ seq \d+/);
    // each verify run is reported with its exit code: 0, 1, 0, 1, 0
    expect([...out.matchAll(/verify exit (\d)/g)].map((m) => m[1])).toEqual([
      '0',
      '1',
      '0',
      '1',
      '0',
    ]);
    expect(out.trim().split('\n').at(-1)).toMatch(/demo done/i);
  }, 240_000);
});
