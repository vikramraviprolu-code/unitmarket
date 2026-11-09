// INT-CTL / CTL.3: POST /api/ops/switches/[name]/off and /on. Off is a fail-safe route (no authenticator code
// needed, a reason code needed); on needs the code and a reason code, and refuses the two switches that keep their
// own controls. Buyers, sellers, bearer keys, a missing CSRF token and a replay are all covered.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootA, idemKey } from './api-v1/a-support';
import type { ARig, Handler, Sess } from './api-v1/a-support';

vi.mock('server-only', () => ({}));

const SWITCHES = [
  'paypal_outbound',
  'agent_buy_enabled',
  'ai_enabled',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'web_import_enabled',
  'webhook_enabled',
] as const;
const TURNABLE = [
  'ai_enabled',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'web_import_enabled',
  'webhook_enabled',
];

let rig: ARig;
let off: { POST: Handler; routeMeta: Record<string, unknown> };
let on: { POST: Handler; routeMeta: Record<string, unknown> };
let op: Sess;
let noMfa: Sess;
const url = (name: string, dir: 'on' | 'off') => `/api/ops/switches/${name}/${dir}`;
const send = (
  dir: 'on' | 'off',
  s: Sess | null,
  name: string,
  body: unknown = { reason_code: 'incident' },
  idem: string | null = idemKey(),
) =>
  rig.old(dir === 'off' ? off.POST : on.POST, s, {
    method: 'POST',
    url: url(name, dir),
    body,
    params: { name },
    idem,
  });
const state = async (name: string): Promise<{ on: boolean; reason: string; changed_by: string }> =>
  (
    await rig.app.db.query<{ on: boolean; reason: string; changed_by: string }>(
      'SELECT "on", reason, changed_by FROM safety_switches WHERE name = $1',
      [name],
    )
  ).rows[0]!;
const setOn = (name: string, v: boolean) =>
  rig.app.db.query('UPDATE safety_switches SET "on" = $2 WHERE name = $1', [name, v]);
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  rig = await bootA();
  off = (await import('./app/api/ops/switches/[name]/off/route')) as never;
  on = (await import('./app/api/ops/switches/[name]/on/route')) as never;
  op = await rig.session({ kind: 'operator', operator_id: 'opr_ctl_mfa', mfa: true });
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_ctl_plain', mfa: false });
});
afterAll(async () => rig.app.close());
// The rate rule is 10 a minute per actor (R2-4); each test starts with full buckets.
beforeEach(async () => {
  await rig.app.db.query('DELETE FROM rate_buckets');
});

describe('route meta', () => {
  it('both routes are operator POST, csrf, idempotent, high risk, 10 per minute per actor (R2-4)', () => {
    for (const r of [off, on]) {
      expect(r.routeMeta).toMatchObject({
        method: 'POST',
        auth: 'operator',
        csrf: true,
        idempotent: true,
        risk: 'high',
      });
      expect(r.routeMeta['rate']).toMatchObject({ per: 'actor', limit: 10, window_ms: 60_000 });
    }
    expect(off.routeMeta['fail_safe_without_mfa']).toBe(true);
    expect(on.routeMeta['fail_safe_without_mfa']).toBeUndefined();
  });
});

describe('rate', () => {
  it('the eleventh change in a minute by one actor is 429 on either route', async () => {
    for (const dir of ['off', 'on'] as const) {
      await rig.app.db.query('DELETE FROM rate_buckets');
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1)
        codes.push((await send(dir, dir === 'off' ? noMfa : op, 'nope')).status);
      expect(
        codes.slice(0, 10).every((c) => c === 404),
        dir,
      ).toBe(true);
      expect(codes[10], dir).toBe(429);
    }
  });
});

describe('off', () => {
  it('works without the authenticator code, stores the reason code, and is journaled on the web channel', async () => {
    const res = await send('off', noMfa, 'ai_enabled', { reason_code: 'partner_request' });
    expect(res.status).toBe(200);
    expect(await state('ai_enabled')).toMatchObject({ on: false, reason: 'partner_request' });
    const ev = await rig.app.db.query<{
      channel: string;
      actor_kind: string;
      actor_id: string | null;
    }>(
      "SELECT channel, actor_kind, actor_id FROM trace_events WHERE source_table = 'safety_switches' AND source_id = 'ai_enabled' ORDER BY seq DESC LIMIT 1",
    );
    expect(ev.rows[0]).toMatchObject({ channel: 'web', actor_kind: 'operator' });
    await setOn('ai_enabled', true);
  });

  it('works for each of the eight switches and can only ever turn them off', async () => {
    for (const name of SWITCHES) {
      await setOn(name, true);
      const res = await send('off', noMfa, name);
      expect(res.status, name).toBe(200);
      expect((await state(name)).on, name).toBe(false);
    }
    for (const name of SWITCHES)
      await setOn(name, name !== 'paypal_outbound' && name !== 'agent_buy_enabled');
  });

  it('a body that tries to say "on" is refused and nothing moves', async () => {
    for (const body of [
      { reason_code: 'incident', on: true },
      { reason_code: 'incident', enabled: true },
    ]) {
      const res = await send('off', noMfa, 'checkout_enabled', body);
      expect(res.status).toBe(422);
      expect((await state('checkout_enabled')).on).toBe(true);
    }
  });

  it('without a reason code, or with one outside the list, is 400 and nothing moves', async () => {
    for (const body of [
      {},
      { reason_code: '' },
      { reason_code: 'because' },
      { reason: 'free text' },
    ]) {
      const res = await send('off', noMfa, 'checkout_enabled', body);
      expect([400, 422], JSON.stringify(body)).toContain(res.status);
    }
    expect((await send('off', noMfa, 'checkout_enabled', {})).status).toBe(400);
    expect((await send('off', noMfa, 'checkout_enabled', { reason_code: 'because' })).status).toBe(
      400,
    );
    expect((await state('checkout_enabled')).on).toBe(true);
  });

  it('an unknown name is 404, however the name is spelled', async () => {
    for (const name of ['nope', 'AI_ENABLED', 'ai_enabled%00', '..%2Fstart', 'mcp:buy_unit', ''])
      expect((await send('off', noMfa, name)).status, name).toBe(404);
  });

  it('buyer, seller, no session and a bearer key are refused; a missing CSRF token is 403', async () => {
    const buyer = await rig.session(rig.buyerA);
    const seller = await rig.session(rig.harbour);
    expect([401, 403]).toContain((await send('off', buyer, 'ai_enabled')).status);
    expect([401, 403]).toContain((await send('off', seller, 'ai_enabled')).status);
    expect((await send('off', null, 'ai_enabled')).status).toBe(401);
    const token = await rig.key(rig.operator, ['ops:read']);
    const viaKey = await rig.old(off.POST, null, {
      method: 'POST',
      url: url('ai_enabled', 'off'),
      body: { reason_code: 'incident' },
      params: { name: 'ai_enabled' },
      idem: idemKey(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(viaKey.status);
    expect((await send('off', { ...noMfa, csrf: 'wrong' }, 'ai_enabled')).status).toBe(403);
    expect((await state('ai_enabled')).on).toBe(true);
  });

  it('a replay with the same Idempotency-Key returns the stored answer and runs once', async () => {
    const k = idemKey();
    const first = await send('off', noMfa, 'unlock_enabled', undefined, k);
    const before = await rig.app.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'switch.unlock_enabled.off'",
    );
    await setOn('unlock_enabled', true);
    const second = await send('off', noMfa, 'unlock_enabled', undefined, k);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect((await state('unlock_enabled')).on).toBe(true);
    const after = await rig.app.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'switch.unlock_enabled.off'",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('on', () => {
  it('without the authenticator code is 403 mfa_required and nothing moves', async () => {
    await setOn('webhook_enabled', false);
    const res = await send('on', noMfa, 'webhook_enabled');
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('mfa_required');
    expect((await state('webhook_enabled')).on).toBe(false);
  });

  it('with the code and a reason code turns the six other switches on', async () => {
    for (const name of TURNABLE) {
      await setOn(name, false);
      const res = await send('on', op, name, { reason_code: 'maintenance' });
      expect(res.status, name).toBe(200);
      expect(await state(name), name).toMatchObject({ on: true, reason: 'maintenance' });
    }
  });

  it('without a reason code is 400', async () => {
    await setOn('webhook_enabled', false);
    expect((await send('on', op, 'webhook_enabled', {})).status).toBe(400);
    expect((await send('on', op, 'webhook_enabled', { reason_code: 'x' })).status).toBe(400);
    expect((await state('webhook_enabled')).on).toBe(false);
    await setOn('webhook_enabled', true);
  });

  it('paypal_outbound and agent_buy_enabled give 409 use_existing_control, and stay as they were', async () => {
    for (const name of ['paypal_outbound', 'agent_buy_enabled']) {
      await setOn(name, false);
      const res = await send('on', op, name);
      expect(res.status, name).toBe(409);
      expect(await errCode(res), name).toBe('use_existing_control');
      expect((await state(name)).on, name).toBe(false);
    }
  });

  it('an unknown name is 404; buyer, seller, no session, a bearer key and a missing CSRF token are refused', async () => {
    expect((await send('on', op, 'nope')).status).toBe(404);
    const buyer = await rig.session(rig.buyerA);
    const seller = await rig.session(rig.harbour);
    expect([401, 403]).toContain((await send('on', buyer, 'ai_enabled')).status);
    expect([401, 403]).toContain((await send('on', seller, 'ai_enabled')).status);
    expect((await send('on', null, 'ai_enabled')).status).toBe(401);
    expect((await send('on', { ...op, csrf: 'wrong' }, 'ai_enabled')).status).toBe(403);
    const token = await rig.key(rig.operator, ['ops:read']);
    const viaKey = await rig.old(on.POST, null, {
      method: 'POST',
      url: url('ai_enabled', 'on'),
      body: { reason_code: 'incident' },
      params: { name: 'ai_enabled' },
      idem: idemKey(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(viaKey.status);
  });

  it('a replay returns the stored answer', async () => {
    await setOn('refunds_enabled', false);
    const k = idemKey();
    const a = await send('on', op, 'refunds_enabled', undefined, k);
    await setOn('refunds_enabled', false);
    const b = await send('on', op, 'refunds_enabled', undefined, k);
    expect(a.status).toBe(200);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect((await state('refunds_enabled')).on).toBe(false);
    await setOn('refunds_enabled', true);
  });

  it('the stored changed_by is the operator label and the journal holds only its sha256', async () => {
    // The journal hashes only the columns that changed, so start from another changer.
    await rig.app.db.query(
      "UPDATE safety_switches SET \"on\" = false, changed_by = 'seed' WHERE name = 'ai_enabled'",
    );
    await send('on', op, 'ai_enabled');
    const row = await state('ai_enabled');
    expect(row.changed_by).toBe('operator:opr_ctl_mfa');
    const ev = await rig.app.db.query<{ body: { hashed: Record<string, [unknown, string]> } }>(
      "SELECT body FROM trace_events WHERE source_table = 'safety_switches' AND source_id = 'ai_enabled' ORDER BY seq DESC LIMIT 1",
    );
    expect(ev.rows[0]!.body.hashed['changed_by']![1]).toBe(
      createHash('sha256').update('operator:opr_ctl_mfa').digest('hex'),
    );
  });
});
