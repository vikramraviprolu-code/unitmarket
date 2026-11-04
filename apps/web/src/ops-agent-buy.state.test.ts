// API-B: POST /api/ops/agent-buy through the real route wrapper and the real app. Turning agent buying on
// needs an operator who signed in with the authenticator code; the stop button turns it off without one;
// a buyer, a publisher, no session and an API key all fail. Time is frozen so the code is exact.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import { NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call } from './support';
import type { Session } from './support';
import { apiKeyDeps } from '../composition.server';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let rig: StartRig | null = null;
let route: typeof import('./app/api/ops/agent-buy/route');
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rig = await bootStartRig();
  route = await import('./app/api/ops/agent-buy/route');
});
afterEach(async () => {
  await rig?.app.close();
  rig = null;
  vi.useRealTimers();
});

const post = (s: Session | null, body: unknown, headers: Record<string, string> = {}) =>
  call(route.POST, { url: '/api/ops/agent-buy', method: 'POST', session: s, body, headers });
const agentOn = async (): Promise<boolean> => {
  const r = await rig!.app.db.query<{ on: boolean }>(
    `SELECT "on" FROM safety_switches WHERE name = 'agent_buy_enabled'`,
  );
  return r.rows[0]?.on === true;
};
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

describe('POST /api/ops/agent-buy', () => {
  it('is off after boot, and an operator with the authenticator code turns it on and off, with audit rows', async () => {
    expect(await agentOn()).toBe(false);
    const op = await rig!.mfaOperator();
    const on = await post(op, { on: true, reason: 'demo sitting' });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ agent_buy_on: true });
    expect(await agentOn()).toBe(true);
    const off = await post(op, { on: false, reason: 'demo over' });
    expect(off.status).toBe(200);
    expect(await agentOn()).toBe(false);
    expect(await rig!.count('switch.agent_buy_enabled.on')).toBe(1);
    expect(await rig!.count('switch.agent_buy_enabled.off')).toBe(1);
  });

  it('refuses an operator without the code (403 mfa_required), a buyer, a publisher and no session; nothing changes', async () => {
    expect((await post(null, { on: true, reason: 'x y z' })).status).toBe(401);
    const { signIn } = await import('./support');
    const b = await signIn(rig!.session.POST, 'buyer-a');
    expect((await post(b, { on: true, reason: 'x y z' })).status).toBe(403);
    expect((await post(await rig!.publisher(), { on: true, reason: 'x y z' })).status).toBe(403);
    const res = await post(await rig!.plainOperator(), { on: true, reason: 'no code' });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('mfa_required');
    expect(await agentOn()).toBe(false);
  });

  it('refuses a blank reason, a stray field and a body that is not a switch change (422)', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, { on: true, reason: '   ' })).status).toBe(422);
    expect((await post(op, { on: true, reason: 'fine', extra: 1 })).status).toBe(422);
    expect((await post(op, { on: 'yes', reason: 'fine' })).status).toBe(422);
    expect(await agentOn()).toBe(false);
  });

  it('no API key of any scope reaches it', async () => {
    const owner = { kind: 'buyer' as const, buyer_id: 'buy_w0a' };
    await rig!.app.db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ('buy_w0a', 'W0', 'w0:buy_w0a', 'GB', $1, $1) ON CONFLICT (id) DO NOTHING`,
      [new Date(NOW).toISOString()],
    );
    const k = await issueKey(apiKeyDeps(rig!.app), {
      owner,
      key_kind: 'api_client',
      scopes: ['catalogue:read', 'mandates:write'],
    });
    if (!k.ok) throw new Error(`issue refused: ${k.error}`);
    const res = await post(
      null,
      { on: true, reason: 'with a key' },
      { authorization: `Bearer ${k.value.token}` },
    );
    expect([401, 403]).toContain(res.status);
    expect(await agentOn()).toBe(false);
  });

  it('the stop button turns agent buying off together with PayPal, with no authenticator code', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, { on: true, reason: 'demo sitting' })).status).toBe(200);
    expect(await agentOn()).toBe(true);
    const stop = await call(rig!.stop.POST, {
      url: '/api/ops/stop',
      method: 'POST',
      session: await rig!.plainOperator(),
      body: { reason: 'stop everything' },
    });
    expect(stop.status).toBe(200);
    expect(await agentOn()).toBe(false);
    expect(await rig!.isOn()).toBe(false);
  });
});
