// BU-3 (integration, several minutes): runs scripts/next-start-proof.mjs, which builds the real Next
// server for apps/web under flock, starts it with `next start` in sandbox mode with FAKE credentials
// and an approval row that excludes every operation the adapter needs, drives a few requests, stops
// it and reads its own log. Offline: the only socket is localhost, the child gets a minimal
// environment of its own (no inherited variable reaches it), and no credential is read.
//
//   corepack pnpm vitest run --project integration scripts/next-start-proof.integration.test.ts
//
// Skipped, with the reason printed, only when `next` is not installed. The proof is opt-in by
// design (not a step of `pnpm ci`); see the PR note about the integration project glob.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const NEXT_INSTALLED = existsSync(join(REPO_ROOT, 'apps/web/node_modules/next/package.json'));
if (!NEXT_INSTALLED) {
  process.stderr.write(
    'next-start-proof.integration: SKIPPED, next is not installed (run: corepack pnpm install --frozen-lockfile --offline)\n',
  );
}

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}
interface Analysis {
  ok: boolean;
  checks: Check[];
  facts: Record<string, unknown>;
}
interface Result {
  ok: boolean;
  start: Analysis;
  override: Analysis;
  timings: { build_ms: number; start_ms: number; override_ms: number };
  temp_dir: string;
  server_pids: number[];
  selfcheck_line: string | null;
  ops_wire_line: string | null;
  table: string;
}

let result: Result;
let exitStatus: number | null;
let scratch: string;
let tableText = '';

beforeAll(() => {
  if (!NEXT_INSTALLED) return;
  scratch = mkdtempSync(join(tmpdir(), 'bu3-proof-test-'));
  const json = join(scratch, 'result.json');
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      join(REPO_ROOT, 'scripts/lib/ts-register.mjs'),
      join(REPO_ROOT, 'scripts/next-start-proof.mjs'),
      '--json',
      json,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
      maxBuffer: 64 * 1024 * 1024,
      // Nothing is inherited: no proxy, no NODE_OPTIONS, no credential variable.
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      timeout: 840_000,
    },
  );
  exitStatus = r.status;
  tableText = `${r.stdout}${r.stderr}`;
  if (existsSync(json)) result = JSON.parse(readFileSync(json, 'utf8')) as Result;
  // The evidence the PR needs, printed once.
  process.stderr.write(`\n${tableText}\n`);
}, 900_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const check = (a: Analysis, id: string): Check => {
  const c = a.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};

describe.skipIf(!NEXT_INSTALLED)('next start proof (offline, fake credentials)', () => {
  it('the script ran to a result and exited 0', () => {
    expect(result, tableText).toBeDefined();
    expect(exitStatus, tableText).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('server listened (no exit 78)', () => {
    expect(check(result.start, 'listened').ok, check(result.start, 'listened').detail).toBe(true);
    expect(check(result.start, 'clean_stop').ok, check(result.start, 'clean_stop').detail).toBe(
      true,
    );
  });

  it('transport.selfcheck: impl node-https, env_override false, builtins_intact true', () => {
    expect(check(result.start, 'selfcheck_line').ok).toBe(true);
    expect(result.start.facts['selfcheck']).toMatchObject({
      impl: 'node-https',
      env_override: false,
      builtins_intact: true,
    });
    expect(result.selfcheck_line).toContain('"msg":"transport.selfcheck"');
    // after Next loaded its route modules and patched fetch, the Wire is still clean
    expect(check(result.start, 'selfcheck_after_load').ok).toBe(true);
  });

  it('global_fetch_changed_since_load is recorded (expected true; the value is evidence either way)', () => {
    expect(check(result.start, 'global_fetch_recorded').ok).toBe(true);
    expect(typeof result.start.facts['global_fetch_changed_after_load']).toBe('boolean');
    expect(typeof result.start.facts['global_fetch_changed_at_start']).toBe('boolean');
  });

  it('every sandbox.send line is blocked:no_approval for oauth_token; none has outcome response or network_error', () => {
    const c = check(result.start, 'sends_blocked');
    expect(c.ok, c.detail).toBe(true);
    expect(Number(result.start.facts['sends'])).toBeGreaterThanOrEqual(1);
    expect(check(result.start, 'checkout_not_completed').ok).toBe(true);
  });

  it('every provider_calls row is blocked', () => {
    const c = check(result.start, 'provider_calls_blocked');
    expect(c.ok, c.detail).toBe(true);
    expect(Number(result.start.facts['provider_calls'])).toBeGreaterThanOrEqual(1);
  });

  it('no stdout or stderr line contains the fake secret or the fake client id', () => {
    expect(check(result.start, 'no_secret_in_output').ok).toBe(true);
    expect(check(result.override, 'no_secret_in_output').ok).toBe(true);
    // and the printed evidence itself carries neither
    expect(tableText).not.toMatch(/fake-client-(id|secret)-bu3-[0-9a-z]{6,}/);
  });

  it('with NODE_OPTIONS=--require the process exits 78 with transport_env_override (register() refuses; nothing is served)', () => {
    expect(check(result.override, 'exit_78').ok).toBe(true);
    expect(check(result.override, 'refusal_names_override').ok).toBe(true);
    expect(check(result.override, 'nothing_served').ok).toBe(true);
    expect(result.override.ok).toBe(true);
  });

  it('records build and start times', () => {
    expect(result.timings.build_ms).toBeGreaterThan(0);
    expect(result.timings.start_ms).toBeGreaterThan(0);
  });

  it('leaves nothing behind: temp dir deleted, no server running, the working tree clean', () => {
    expect(existsSync(result.temp_dir)).toBe(false);
    for (const pid of result.server_pids) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive, `pid ${pid} still running`).toBe(false);
    }
    const git = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(git.stdout).toBe('');
  });
});
