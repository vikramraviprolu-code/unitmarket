// AI-B state tests: the operator evals page's engine method and page source. The page runs only the
// scripted model over the committed injection cases; no network, no key, no model call.
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { createScriptedModel, runEvalCases, tally } from '@umsbx/model';
import cases from '../../../packages/model/test-data/injection-cases.json';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';

vi.mock('server-only', () => ({}));

const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const BUYER: Actor = { kind: 'buyer', buyer_id: 'buy_persona_a' };
const PUBLISHER: Actor = { kind: 'publisher', publisher_id: 'pub_x' };
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const apps: App[] = [];
const dirs: string[] = [];
async function boot(over: Record<string, string> = {}, file?: string): Promise<App> {
  const app = createApp(await testEnv(over), {
    switch_cache_ms: 0,
    ...(file === undefined ? {} : { test_claude_eval_file: file }),
  });
  installApp(app);
  await app.ready();
  apps.push(app);
  return app;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpFile = (text: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'aib-'));
  dirs.push(d);
  const f = join(d, 'claude-eval-result.json');
  writeFileSync(f, text);
  return f;
};

describe('evalsSummary', () => {
  it('counts equal the committed JSON, and the baseline equals running the shared checks', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const app = await boot();
    const s = await app.engine.evalsSummary(OPERATOR);
    expect(s).not.toBeNull();
    expect(s!.listing_cases).toBe(cases.listing_injections.length);
    expect(s!.brief_cases).toBe(cases.brief_jailbreaks.length);
    const expected = await runEvalCases(createScriptedModel());
    expect(s!.cases).toEqual(expected);
    expect(s!.baseline).toEqual(tally(expected));
    expect(s!.baseline.total).toBe(s!.listing_cases + s!.brief_cases);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is operator only: buyer, publisher get null', async () => {
    const app = await boot();
    expect(await app.engine.evalsSummary(BUYER)).toBeNull();
    expect(await app.engine.evalsSummary(PUBLISHER)).toBeNull();
  });

  it('says not_run without the Claude result file, and names the scripted model', async () => {
    const app = await boot();
    const s = await app.engine.evalsSummary(OPERATOR);
    expect(s!.claude).toEqual({ state: 'not_run' });
    expect(s!.model_in_use).toBe('scripted');
    expect(s!.environment).toBe(app.engine.environment);
  });

  it('shows a stored Claude result with its counts and date', async () => {
    const f = tmpFile(JSON.stringify({ recorded_on: '2026-11-01', passed: 50, total: 52 }));
    const app = await boot({}, f);
    const s = await app.engine.evalsSummary(OPERATOR);
    expect(s!.claude).toEqual({ state: 'recorded', recorded_on: '2026-11-01', passed: 50, total: 52 });
  });

  it('treats a malformed or impossible result file as not run', async () => {
    for (const text of [
      'not json',
      '{}',
      JSON.stringify({ recorded_on: 'yesterday', passed: 1, total: 2 }),
      JSON.stringify({ recorded_on: '2026-11-01', passed: 3, total: 2 }),
      JSON.stringify({ recorded_on: '2026-11-01', passed: 1.5, total: 2 }),
    ]) {
      const app = await boot({}, tmpFile(text));
      const s = await app.engine.evalsSummary(OPERATOR);
      expect(s!.claude, text).toEqual({ state: 'not_run' });
      await app.close();
      apps.pop();
    }
  });

  it('a missing file path is not run', async () => {
    const app = await boot({}, join(tmpdir(), 'aib-does-not-exist', 'x.json'));
    expect((await app.engine.evalsSummary(OPERATOR))!.claude).toEqual({ state: 'not_run' });
  });

  it('holds no model free text: case rows are an id, a kind, a verdict and fixed codes', async () => {
    const app = await boot();
    const s = await app.engine.evalsSummary(OPERATOR);
    for (const c of s!.cases) expect(Object.keys(c).sort()).toEqual(['failed', 'id', 'kind', 'pass']);
    expect(JSON.stringify(s)).not.toMatch(/reason|EVIL/);
  });
});

describe('the evals page source', () => {
  const src = read('./app/ops/evals/page.tsx');
  const code = src.replace(/\/\/.*$/gm, '');

  it('sends anyone but an operator to sign in, and reads only evalsSummary', () => {
    expect(code).toMatch(/actor\?\.kind !== 'operator'/);
    expect(code).toMatch(/redirect\('\/signin\?next=\/ops\/evals'\)/);
    expect(code).toMatch(/evalsSummary\(actor\)/);
  });
  it('takes its words from lib/evals-copy and its label from the stored environment', () => {
    expect(code).toMatch(/from '\.\.\/\.\.\/\.\.\/lib\/evals-copy'/);
    expect(code).toMatch(/<EnvLabel environment=\{[a-z.]*environment\}/);
    expect(code).not.toMatch(/Sandbox|Dry run|Dry-run/);
  });
  it('shows n of m, per case verdicts and no model free text', () => {
    expect(code).toMatch(/data-testid="evals-cases"/);
    expect(code).toMatch(/data-testid="evals-baseline"/);
    expect(code).toMatch(/data-testid="evals-claude"/);
    expect(code).not.toMatch(/\.reason|dangerouslySetInnerHTML|%/);
  });
  it('uses no inline style, no italics, no external resource and no network call', () => {
    expect(code).not.toMatch(/style=|<i>|<em>|https?:\/\/|fetch\(|useEffect|'use client'/);
  });
  it('is linked from /ops', () => {
    expect(read('./app/ops/page.tsx')).toMatch(/href="\/ops\/evals"/);
  });
});
