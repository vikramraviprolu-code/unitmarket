// Tests of the offline PERF-2 script (B-L7): the statistics, the verdict above and below the budget,
// and one real small run through the CLI that writes its JSON and fails when the budget is too low.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERF2_BUDGET_MS, PERF2_N, percentile, summarize, verdict } from './perf-offline.mjs';

const ROOT = join(__dirname, '..');
const run = (...args: string[]) =>
  spawnSync(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      './scripts/lib/ts-register.mjs',
      'scripts/perf-offline.mjs',
      ...args,
    ],
    { cwd: ROOT, encoding: 'utf8', env: {} },
  );

describe('perf-offline statistics', () => {
  it('uses the nfr.md figures: 200 requests, 300 ms', () => {
    expect(PERF2_N).toBe(200);
    expect(PERF2_BUDGET_MS).toBe(300);
  });
  it('percentile is nearest-rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 0.95)).toBe(95);
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.95)).toBe(0);
  });
  it('the 200-sample p95 is the 190th value: ten slow requests pass, eleven fail', () => {
    const slow = (k: number) => [...Array(200 - k).fill(5), ...Array(k).fill(500)] as number[];
    const quiet = Array(200).fill(5) as number[];
    expect(verdict(slow(10), quiet, 300).ok).toBe(true);
    expect(verdict(slow(11), quiet, 300).ok).toBe(false);
    expect(verdict(quiet, slow(11), 300).ok).toBe(false);
  });
  it('fails when either p95 is above the budget, passes at the budget', () => {
    expect(verdict([10, 10], [301, 301], 300).ok).toBe(false);
    expect(verdict([301, 301], [10, 10], 300).ok).toBe(false);
    expect(verdict([300, 300], [300, 300], 300).ok).toBe(true);
    expect(summarize([1, 2, 3, 4]).max).toBe(4);
  });
});

describe('perf-offline CLI (small real run, offline)', () => {
  it('writes the JSON result and exits 0 within the budget; exits 1 above it; exits 2 on bad input', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'perf-')), 'r.json');
    const ok = run('--n', '15', '--out', out);
    expect(ok.status).toBe(0);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    expect(result).toMatchObject({ n: 15, budget_ms: 300, ok: true });
    expect(result.quote.p95).toBeGreaterThan(0);
    expect(result.approval.p95).toBeGreaterThan(0);
    const tight = run('--n', '15', '--budget-ms', '0.0001', '--out', out);
    expect(tight.status).toBe(1);
    expect(JSON.parse(readFileSync(out, 'utf8')).ok).toBe(false);
    expect(run('--n', '0').status).toBe(2);
  }, 60_000);
});
