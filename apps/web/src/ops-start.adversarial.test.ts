// WEB-OPS-START (adversarial): what a hostile operator-without-code, a replayer or a cross-site page can do
// to POST /api/ops/start. Real route wrapper, real app, frozen Date. Nothing reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, call } from './support';
import { NOW, SCOPE, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let rig: StartRig | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await rig?.app.close();
  rig = null;
  vi.useRealTimers();
});
const ok = { reason: 'tester sitting', confirm_scope: SCOPE };

describe('start: forged and malformed requests', () => {
  it('a missing or wrong CSRF token answers 403 and nothing changes', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    expect((await rig.startAs(op, ok, { csrf: false })).status).toBe(403);
    const wrong = await call(rig.start.POST, {
      url: '/api/ops/start',
      method: 'POST',
      session: op,
      body: ok,
      csrf: false,
      headers: { 'x-csrf-token': 'not-the-token' },
    });
    expect(wrong.status).toBe(403);
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
  });

  it('a request from another origin answers 403 even with a good session and token', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    for (const origin of ['https://evil.example', 'null', '']) {
      const res = await rig.start.POST(
        new Request(`${ORIGIN}/api/ops/start`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: op.cookie,
            'x-csrf-token': op.csrf,
          },
          body: JSON.stringify(ok),
        }),
        { params: Promise.resolve({}) },
      );
      expect(res.status, origin).toBe(403);
    }
    expect(await rig.isOn()).toBe(false);
  });

  it.each([
    ['an extra field', { ...ok, on: true }],
    ['an approval ref', { ...ok, approval_ref: 'DL-evil' }],
    ['a scope override', { ...ok, scope: 'mvp_c_refunds' }],
    ['a connect flag', { ...ok, connect: 'on' }],
    ['no reason', { confirm_scope: SCOPE }],
    ['no typed scope', { reason: 'tester sitting' }],
    ['a number for the reason', { ...ok, reason: 12345 }],
    ['an array', [ok]],
  ])('unknown or missing fields (%s) answer 4xx and change nothing', async (_n, bad) => {
    rig = await bootStartRig();
    const res = await rig.startAs(await rig.mfaOperator(), bad);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
  });

  it('a body that is not JSON, or larger than the route allows, is refused', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    const raw = (b: string) =>
      rig!.start.POST(
        new Request(`${ORIGIN}/api/ops/start`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            cookie: op.cookie,
            'x-csrf-token': op.csrf,
          },
          body: b,
        }),
        { params: Promise.resolve({}) },
      );
    expect((await raw('not json')).status).toBe(400);
    expect((await raw(JSON.stringify({ ...ok, reason: 'x'.repeat(5000) }))).status).toBe(413);
    expect(await rig.isOn()).toBe(false);
  });

  it('a GET is not a start', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    const res = await rig.start.POST(
      new Request(`${ORIGIN}/api/ops/start`, { method: 'GET', headers: { cookie: op.cookie } }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(404);
    expect(await rig.isOn()).toBe(false);
  });
});

describe('start: sessions', () => {
  it('a stolen plain-session cookie (no authenticator code) cannot start, however often it tries', async () => {
    rig = await bootStartRig();
    const plain = await rig.plainOperator();
    for (let i = 0; i < 4; i += 1) {
      const res = await rig.startAs(plain, ok);
      expect(res.status).toBe(403);
    }
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
  });

  it('a signed out or tampered cookie answers 401', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    expect((await rig.startAs({ ...op, cookie: `${op.cookie}x` }, ok)).status).toBe(401);
    expect((await rig.startAs({ cookie: 'um_session=garbage', csrf: op.csrf }, ok)).status).toBe(
      401,
    );
    expect(await rig.isOn()).toBe(false);
  });

  it('a replayed request does nothing the second time: 409 already_on and still one audit row', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    expect((await rig.startAs(op, ok)).status).toBe(200);
    const again = await rig.startAs(op, ok);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('already_on');
    expect(await rig.count('safety.resume')).toBe(1);
    expect(await rig.count('switch.paypal_outbound.on')).toBe(1);
  });

  it('the 6th call within an hour answers 429, and the 5 before it were answered normally', async () => {
    rig = await bootStartRig({ approval: false });
    const op = await rig.mfaOperator();
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await rig.startAs(op, ok)).status);
    expect(codes).toEqual([409, 409, 409, 409, 409, 429]);
    expect(await rig.isOn()).toBe(false);
  });

  it('stop still works without the authenticator code, and cannot turn anything on', async () => {
    rig = await bootStartRig({ on: true });
    const plain = await rig.plainOperator();
    const res = await call(rig.stop.POST, {
      url: '/api/ops/stop',
      method: 'POST',
      session: plain,
      body: { reason: 'drill without a code' },
    });
    expect(res.status).toBe(200);
    expect(await rig.isOn()).toBe(false);
    // a second press keeps it off
    const again = await call(rig.stop.POST, {
      url: '/api/ops/stop',
      method: 'POST',
      session: plain,
      body: { reason: 'second press' },
    });
    expect(again.status).toBe(200);
    expect(await rig.isOn()).toBe(false);
  });
});

describe('start: what leaves the app', () => {
  it('the route is the only way on and no PayPal call goes out, with the connect flag off or on', async () => {
    for (const connect of [false, true]) {
      rig = await bootStartRig({ connect });
      const res = await rig.startAs(await rig.mfaOperator(), ok);
      expect(res.status).toBe(200);
      expect(rig.wire.calls).toHaveLength(0);
      await rig.app.close();
      rig = null;
    }
  });

  it('an answer never carries the approval secret columns, a stack or a credential', async () => {
    rig = await bootStartRig();
    const res = await rig.startAs(await rig.mfaOperator(), ok);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'calls_left',
      'connect_flag',
      'outbound_on',
      'valid_until',
    ]);
    expect(text).not.toMatch(/placeholder|secret|passcode|stack/i);
  });
});
