// AI-A state tests: which model the composition builds. The default is the scripted model and opens
// no socket. With UMS_AI_ADAPTER=claude and a key the Claude adapter is built, over an injected fake
// wire (tests only): no key is real and no request leaves the process. The spend store writes
// audit_log rows (action model.spend).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ModelWire } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';

vi.mock('server-only', () => ({}));

const KEY = 'SYNTHETIC-MODEL-KEY-not-a-credential-0003';
const BUYER: Actor = { kind: 'buyer', buyer_id: 'buy_persona_a' };
const GOOD_BRIEF = {
  need: 'solar guide',
  ceiling_minor: 500,
  currency: 'USD',
  option: null,
  language: null,
  terms: ['solar', 'guide'],
};
const answer = (text: string) => ({
  status: 200,
  body: JSON.stringify({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  }),
});

const apps: App[] = [];
async function boot(over: Record<string, string>, wire?: ModelWire): Promise<App> {
  const app = createApp(await testEnv(over), {
    switch_cache_ms: 0,
    ...(wire === undefined ? {} : { test_model_wire: wire }),
  });
  installApp(app);
  await app.ready();
  apps.push(app);
  return app;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const a of apps.splice(0)) await a.close();
});

describe('the default config', () => {
  it('uses the scripted model, builds no Claude adapter and opens no socket', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const app = await boot({});
    expect(app.config.ai_adapter).toBe('scripted');
    expect(app.model_id).toBe('scripted-v1');
    const r = await app.engine.parseNeed({ actor: BUYER, text: 'solar guide under $5' });
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('writes no model.spend row', async () => {
    const app = await boot({});
    await app.engine.parseNeed({ actor: BUYER, text: 'solar guide' });
    const n = await app.db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'model.spend'`,
    );
    expect(Number(n.rows[0]?.n)).toBe(0);
  });
  it('UMS_AI_ADAPTER=scripted with a key present still uses the scripted model', async () => {
    const app = await boot({ UMS_AI_ADAPTER: 'scripted', UMS_ANTHROPIC_API_KEY: KEY });
    expect(app.model_id).toBe('scripted-v1');
  });
});

describe('UMS_AI_ADAPTER=claude with a key', () => {
  const env = { UMS_AI_ADAPTER: 'claude', UMS_ANTHROPIC_API_KEY: KEY };

  it('builds the Claude model over the injected wire and writes one model.spend row per call', async () => {
    const send = vi.fn<ModelWire['send']>(async () => answer(JSON.stringify(GOOD_BRIEF)));
    const app = await boot(env, { send });
    expect(app.model_id).toBe('claude-haiku-5-5');
    const r = await app.engine.parseNeed({ actor: BUYER, text: 'solar guide under $5' });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await app.db.query<{ micro: string | number; actor_kind: string; reason: string }>(
      `SELECT (detail->>'micro_usd')::bigint AS micro, actor_kind, reason
         FROM audit_log WHERE action = 'model.spend'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0]!.micro)).toBeGreaterThan(0);
    expect(rows.rows[0]!.actor_kind).toBe('system');
    expect(JSON.stringify(rows.rows)).not.toContain(KEY);
  });
  it('an error from the wire falls back to the scripted answer; the buyer still gets a brief', async () => {
    const send = vi.fn(async () => {
      throw new Error('network down');
    });
    const app = await boot(env, { send });
    const r = await app.engine.parseNeed({ actor: BUYER, text: 'solar guide under $5' });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('the key appears in no audit row and no log line', async () => {
    const lines: string[] = [];
    const send = vi.fn(async () => answer('not json'));
    const app = createApp(await testEnv(env), {
      switch_cache_ms: 0,
      test_model_wire: { send },
      log_sink: (l) => lines.push(l),
    });
    installApp(app);
    await app.ready();
    apps.push(app);
    await app.engine.parseNeed({ actor: BUYER, text: 'solar guide' });
    const all = await app.db.query(`SELECT * FROM audit_log`);
    expect(JSON.stringify(all.rows)).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain(KEY);
  });
  it('the daily cap is read from audit_log: rows already written today stop the next call', async () => {
    const send = vi.fn(async () => answer(JSON.stringify(GOOD_BRIEF)));
    const app = await boot(env, { send });
    await app.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ('aud_synthetic_fill', 'system', NULL, 'model.spend', NULL, 'synthetic fill',
                 '{"micro_usd": 2000000}'::jsonb, now(), now())`,
      );
    });
    const r = await app.engine.parseNeed({ actor: BUYER, text: 'solar guide under $5' });
    expect(r.ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it('the stop switch ends AI calls: paypal_outbound off means zero sends and the scripted answer', async () => {
    const send = vi.fn<ModelWire['send']>(async () => answer(JSON.stringify(GOOD_BRIEF)));
    const app = await boot(env, { send });
    const first = await app.engine.parseNeed({ actor: BUYER, text: 'solar guide under $5' });
    expect(first.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await app.db.query(
      `UPDATE safety_switches SET "on" = false, changed_by = 'test:stop', updated_at = now() WHERE name = 'paypal_outbound'`,
    );
    const after = await app.engine.parseNeed({ actor: BUYER, text: 'solar guide under $5' });
    expect(after.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const spend = await app.db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'model.spend'`,
    );
    expect(Number(spend.rows[0]?.n)).toBe(1);
  });
  it('a test wire is refused outside NODE_ENV=test', async () => {
    const env2 = await testEnv({ ...env, NODE_ENV: 'development' });
    expect(() => createApp(env2, { test_model_wire: { send: vi.fn() } })).toThrow(
      /test_model_wire outside NODE_ENV=test/,
    );
  });
});
