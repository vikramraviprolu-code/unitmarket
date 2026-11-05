// POB-M1: POST /api/ops/fee through the real route wrapper and the real app. An operator who signed in with the
// authenticator code, a CSRF token and an Idempotency-Key sets the platform fee on top (0 to 30 percent, in basis
// points); the latest setting is what a new publish reads; a replay of the same key gives the first answer; no other
// caller reaches it. Nothing here moves money or changes a price that is already listed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import { NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call, signIn } from './support';
import type { Session } from './support';
import { apiKeyDeps } from '../composition.server';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let rig: StartRig | null = null;
let route: typeof import('./app/api/ops/fee/route');
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rig = await bootStartRig();
  route = await import('./app/api/ops/fee/route');
});
afterEach(async () => {
  await rig?.app.close();
  rig = null;
  vi.useRealTimers();
});

const body = (over: Record<string, unknown> = {}) => ({
  fee_bps: 750,
  reason: 'Pilot rate for the first month',
  ...over,
});
const post = (
  s: Session | null,
  b: unknown,
  key: string | null = 'fee-key-0001',
  extra: Record<string, string> = {},
  csrf = true,
) =>
  call(route.POST, {
    url: '/api/ops/fee',
    method: 'POST',
    session: s,
    body: b,
    csrf,
    headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...extra },
  });
const rows = async (): Promise<number> =>
  Number(
    (await rig!.app.db.query<{ n: string }>('SELECT count(*) AS n FROM fee_settings')).rows[0]!.n,
  );
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

describe('the route is declared as the spec says', () => {
  it('routeMeta', () => {
    expect(route.routeMeta).toMatchObject({
      path: '/api/ops/fee',
      method: 'POST',
      auth: 'operator',
      csrf: true,
      idempotent: true,
      risk: 'high',
      rate: { name: 'ops_fee', per: 'actor', limit: 20, window_ms: 3_600_000 },
    });
  });
});

describe('POST /api/ops/fee', () => {
  it('starts at the seeded 10 percent', async () => {
    expect(await rows()).toBe(1);
    const op = await rig!.mfaOperator();
    expect((await rig!.app.engine.opsFee.get(await actorOf(op)))?.fee_bps).toBe(1000);
  });

  it('an operator with the code sets it: 200, one more row, one audit event, a new publish reads it', async () => {
    const op = await rig!.mfaOperator();
    const res = await post(op, body());
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ fee_bps: 750 });
    expect(String(out['id'])).toMatch(/^rls_/);
    expect(await rows()).toBe(2);
    expect(await rig!.count('fee.set')).toBe(1);
    const policy = await rig!.app.engine.feePolicy();
    expect(policy.fee_bps).toBe(750);
    expect(policy.feeFor(100, 'USD')).toMatchObject({ fee_minor: 8, buyer_minor: 108 }); // 7.5 rounds up
  });

  it('accepts 0 and 3000 and refuses 3001 and a negative value with plain words', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, body({ fee_bps: 0 }), 'fee-key-zero')).status).toBe(200);
    expect((await post(op, body({ fee_bps: 3000 }), 'fee-key-max')).status).toBe(200);
    const over = await post(op, body({ fee_bps: 3001 }), 'fee-key-over');
    expect(over.status).toBe(422);
    expect(await errCode(over)).toBe('fee_invalid');
    const msg = ((await over.json()) as { error: { message: string } }).error.message;
    expect(msg).toMatch(/0 to 30/);
    expect(msg).not.toMatch(/bps|SQL|rls_|stack/i);
    const neg = await post(op, body({ fee_bps: -1 }), 'fee-key-neg');
    expect(neg.status).toBe(422);
    expect(await rows()).toBe(3);
  });

  it('a reason that is too short is refused (422 reason_invalid) and nothing is stored', async () => {
    const op = await rig!.mfaOperator();
    const res = await post(op, body({ reason: 'ab' }), 'fee-key-short');
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('reason_invalid');
    expect(await rows()).toBe(1);
  });

  it('needs an Idempotency-Key: without one, 422 idempotency_key and nothing stored', async () => {
    const res = await post(await rig!.mfaOperator(), body(), null);
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('idempotency_key');
    expect(await rows()).toBe(1);
  });

  it('the same key and body replays the first answer: one new row, one audit event', async () => {
    const op = await rig!.mfaOperator();
    const first = await post(op, body());
    const a = await first.json();
    const second = await post(op, body());
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(await second.json()).toEqual(a);
    expect(await rows()).toBe(2);
    expect(await rig!.count('fee.set')).toBe(1);
  });

  it('the same key with another body is 422 idempotency_key_reused and stores nothing more', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, body())).status).toBe(200);
    const res = await post(op, body({ fee_bps: 800 }));
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('idempotency_key_reused');
    expect(await rows()).toBe(2);
  });

  it('refuses an operator without the code (403 mfa_required), a buyer, a publisher, no session, no CSRF', async () => {
    expect((await post(null, body())).status).toBe(401);
    const b = await signIn(rig!.session.POST, 'buyer-a');
    expect((await post(b, body())).status).toBe(403);
    expect((await post(await rig!.publisher(), body())).status).toBe(403);
    const plain = await post(await rig!.plainOperator(), body());
    expect(plain.status).toBe(403);
    expect(await errCode(plain)).toBe('mfa_required');
    const noCsrf = await post(await rig!.mfaOperator(), body(), 'fee-key-csrf', {}, false);
    expect(noCsrf.status).toBe(403);
    expect(await rows()).toBe(1);
  });

  it('refuses a stray field, a missing field and a value of the wrong type (422)', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, body({ set_by: 'opr_other' }), 'fee-key-s1')).status).toBe(422);
    const noReason: Record<string, unknown> = body();
    delete noReason['reason'];
    expect((await post(op, noReason, 'fee-key-s2')).status).toBe(422);
    expect((await post(op, body({ fee_bps: '750' }), 'fee-key-s3')).status).toBe(422);
    expect((await post(op, body({ fee_bps: 7.5 }), 'fee-key-s4')).status).toBe(422);
    expect(await rows()).toBe(1);
  });

  it('no API key of any scope reaches it', async () => {
    await rig!.app.db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ('buy_w0a', 'W0', 'w0:buy_w0a', 'GB', $1, $1) ON CONFLICT (id) DO NOTHING`,
      [new Date(NOW).toISOString()],
    );
    const k = await issueKey(apiKeyDeps(rig!.app), {
      owner: { kind: 'buyer' as const, buyer_id: 'buy_w0a' },
      key_kind: 'api_client',
      scopes: ['catalogue:read', 'mandates:write'],
    });
    if (!k.ok) throw new Error(`issue refused: ${k.error}`);
    const res = await post(null, body(), 'fee-key-apikey', {
      authorization: `Bearer ${k.value.token}`,
    });
    expect([401, 403]).toContain(res.status);
    expect(await rows()).toBe(1);
  });

  it('a fee set now does not change the price of an offer that is already listed', async () => {
    const before = await rig!.app.db.query<{ options: unknown }>(
      'SELECT id, options FROM offers ORDER BY id',
    );
    expect((await post(await rig!.mfaOperator(), body({ fee_bps: 3000 }))).status).toBe(200);
    const after = await rig!.app.db.query<{ options: unknown }>(
      'SELECT id, options FROM offers ORDER BY id',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('only an operator reads the setting and its history through the engine', async () => {
    const op = await rig!.mfaOperator();
    await post(op, body());
    const view = await rig!.app.engine.opsFee.get(await actorOf(op));
    expect(view?.fee_bps).toBe(750);
    expect(view?.history.map((h) => h.fee_bps)).toEqual([750, 1000]);
    expect(await rig!.app.engine.opsFee.get({ kind: 'buyer', buyer_id: 'buy_x' })).toBeNull();
    expect(
      await rig!.app.engine.opsFee.get({ kind: 'publisher', publisher_id: 'pub_x' }),
    ).toBeNull();
  });
});

async function actorOf(_s: Session) {
  return { kind: 'operator' as const, operator_id: 'vikram', mfa: true };
}
