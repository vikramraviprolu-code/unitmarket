// CO-6 (C-08): operator sign-in with a TOTP code, through the real session route and the real app.
// Time is frozen with a fake Date (the app's clock is the system clock), so the code, the replay
// check, the 30 min idle end and the limiter are all exact. Keys are fixed test strings, not credentials.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { base32Decode, isOperatorName, withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { createApp, installApp } from '../composition.server';
import { PASSCODE, bootTestApp, call, testEnv } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

const VIKRAM_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 test key
const SAKTHI_B32 = 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U';
const KEYS = `vikram:${VIKRAM_B32},sakthi:${SAKTHI_B32}`;
const MIN = 60_000;
const T0 = Date.parse('2026-10-22T09:00:00.000Z');

// RFC 6238 once more, here, so the test does not trust the code under test to make its own codes.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function code(b32: string, atMs: number, delta = 0): string {
  const bits = [...b32].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes = (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000) + delta));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let app: App;
let sessionRoute: typeof import('./app/api/session/route');
let nowMs: number;

const setNow = (ms: number) => {
  nowMs = ms;
  vi.setSystemTime(ms);
};
const advance = (ms: number) => setNow(nowMs + ms);

// Each test gets its own app, its own hour of fake time and so its own steps.
let hour = 0;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(T0 + hour++ * 60 * MIN);
});
afterEach(async () => {
  await app?.close();
  vi.useRealTimers();
});

async function boot(keys: string | null = KEYS) {
  app = await bootTestApp({
    ...(keys === null ? {} : { UMS_OPERATOR_TOTP_KEYS: keys }),
  });
  sessionRoute = await import('./app/api/session/route');
}

interface SignIn {
  status: number;
  session: Session | null;
  body: { csrf_token?: string; actor_kind?: string; mfa?: boolean } | null;
  setCookie: string | null;
}
async function signIn(o: { operator?: string; code?: string; passcode?: string }): Promise<SignIn> {
  const res = await call(sessionRoute.POST, {
    url: '/api/session',
    method: 'POST',
    body: {
      persona: 'operator',
      passcode: o.passcode ?? PASSCODE,
      ...(o.operator === undefined ? {} : { operator: o.operator }),
      ...(o.code === undefined ? {} : { code: o.code }),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  const body = text.startsWith('{') ? (JSON.parse(text) as SignIn['body']) : null;
  const session =
    res.status === 200 && setCookie !== null && body?.csrf_token
      ? { cookie: setCookie.split(';')[0] ?? '', csrf: body.csrf_token }
      : null;
  return { status: res.status, session, body, setCookie };
}

const actorOf = (s: Session | null): Promise<Actor | null> =>
  app.engine.actorFromCookie(s?.cookie ?? null);

// The shape CO-8's refund route will have: an operator POST with CSRF, no fail-safe exemption.
const refundMeta: RouteMeta = {
  path: '/api/refunds',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};
const refundRoute = () =>
  withRoute(refundMeta, z.object({ reason: z.string() }).strict(), async () => ({
    status: 200 as const,
    body: { refunded: true },
  }))(app.security);
const postRefund = (s: Session | null) =>
  call(refundRoute(), {
    url: '/api/refunds',
    method: 'POST',
    body: { reason: 'test' },
    session: s,
  });

describe('operator sign-in without a code', () => {
  it('signs in with mfa false as the unverified operator; a refund answers 403 mfa_required', async () => {
    await boot();
    const r = await signIn({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ actor_kind: 'operator', mfa: false });
    expect(await actorOf(r.session)).toEqual({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    const refund = await postRefund(r.session);
    expect(refund.status).toBe(403);
    expect(((await refund.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
  });
  it('a name without a code is still the unverified operator, not that named operator', async () => {
    await boot();
    const r = await signIn({ operator: 'vikram' });
    expect(await actorOf(r.session)).toEqual({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
  });
  it('can still press stop (the fail-safe route) without a second factor', async () => {
    await boot();
    const r = await signIn({});
    const stop = await import('./app/api/ops/stop/route');
    const res = await call(stop.POST, {
      url: '/api/ops/stop',
      method: 'POST',
      body: { reason: 'drill' },
      session: r.session,
    });
    expect(res.status).toBe(200);
  });
});

describe('operator sign-in with a right code', () => {
  it('gives mfa true as opr_<name>, and the refund route runs', async () => {
    await boot();
    const r = await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ actor_kind: 'operator', mfa: true });
    expect(await actorOf(r.session)).toEqual({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    });
    expect((await postRefund(r.session)).status).toBe(200);
  });
  it('accepts the step before and the step after (clock skew), not two away', async () => {
    await boot();
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, -1) })).status).toBe(
      200,
    );
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, 1) })).status).toBe(
      200,
    );
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, 2) })).status).toBe(
      401,
    );
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, -2) })).status).toBe(
      401,
    );
  });
  it('writes one operator.totp_used audit row (operator, step) and a session.create row with the flag', async () => {
    await boot();
    const c = code(VIKRAM_B32, nowMs);
    await signIn({ operator: 'vikram', code: c });
    const used = await app.security.db.query<{ actor_id: string; detail: Record<string, unknown> }>(
      "SELECT actor_id, detail FROM audit_log WHERE action = 'operator.totp_used'",
    );
    expect(used.rows).toHaveLength(1);
    expect(used.rows[0]?.actor_id).toBe('opr_vikram');
    expect(used.rows[0]?.detail).toMatchObject({
      step: Math.floor(nowMs / 30_000),
      actor_mfa: true,
    });
    const created = await app.security.db.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_log WHERE action = 'session.create' AND actor_id = 'opr_vikram'",
    );
    expect(created.rows[0]?.detail).toMatchObject({ actor_mfa: true });
    const all = JSON.stringify((await app.security.db.query('SELECT * FROM audit_log')).rows);
    expect(all).not.toContain(c);
    expect(all).not.toContain(VIKRAM_B32);
  });
});

describe('operator sign-in refused', () => {
  it('a wrong code: 401, the same answer as a wrong passcode, and no cookie', async () => {
    await boot();
    const wrongCode = await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, 9) });
    const wrongPass = await signIn({
      operator: 'vikram',
      code: code(VIKRAM_B32, nowMs),
      passcode: 'not the passcode',
    });
    for (const r of [wrongCode, wrongPass]) {
      expect(r.status).toBe(401);
      expect(r.setCookie).toBeNull();
      expect(r.body).toMatchObject({ error: { code: 'sign_in_failed' } });
    }
  });
  it('a wrong passcode does not use up the code; the right passcode then signs in with it', async () => {
    await boot();
    const c = code(VIKRAM_B32, nowMs);
    expect((await signIn({ operator: 'vikram', code: c, passcode: 'nope' })).status).toBe(401);
    expect((await signIn({ operator: 'vikram', code: c })).status).toBe(200);
  });
  it('the same code twice: the second is refused (replay)', async () => {
    await boot();
    const c = code(VIKRAM_B32, nowMs);
    expect((await signIn({ operator: 'vikram', code: c })).status).toBe(200);
    expect((await signIn({ operator: 'vikram', code: c })).status).toBe(401);
  });
  it("another operator's code, an unknown name and a code with no name are all refused", async () => {
    await boot();
    expect((await signIn({ operator: 'vikram', code: code(SAKTHI_B32, nowMs) })).status).toBe(401);
    expect((await signIn({ operator: 'nobody', code: code(VIKRAM_B32, nowMs) })).status).toBe(401);
    expect((await signIn({ code: code(VIKRAM_B32, nowMs) })).status).toBe(401);
    // none of them used the code up
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs) })).status).toBe(200);
  });
  it('malformed fields are a 422 with field names only', async () => {
    await boot();
    const res = await call(sessionRoute.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'operator', passcode: PASSCODE, code: 123456 },
    });
    expect(res.status).toBe(422);
    const extra = await call(sessionRoute.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'operator', passcode: PASSCODE, mfa: true },
    });
    expect(extra.status).toBe(422);
  });
  it('six wrong codes lock the persona bucket (5 per 15 min): the sixth is 429, even with the right code', async () => {
    await boot();
    for (let n = 0; n < 5; n++)
      expect(
        (await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, 10 + n) })).status,
      ).toBe(401);
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs, 20) })).status).toBe(
      429,
    );
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs) })).status).toBe(429);
    advance(15 * MIN);
    expect((await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs) })).status).toBe(200);
  });
});

describe('the session of an operator with mfa', () => {
  it('ends after 30 min idle (C-08)', async () => {
    await boot();
    const r = await signIn({ operator: 'vikram', code: code(VIKRAM_B32, nowMs) });
    advance(29 * MIN);
    expect(await actorOf(r.session)).toMatchObject({ mfa: true });
    advance(29 * MIN);
    expect(await actorOf(r.session)).toMatchObject({ mfa: true });
    advance(31 * MIN);
    expect(await actorOf(r.session)).toBeNull();
    expect((await postRefund(r.session)).status).toBe(401);
  });
  it('ends at 8 h even when used every 20 min', async () => {
    await boot();
    const r = await signIn({ operator: 'sakthi', code: code(SAKTHI_B32, nowMs) });
    for (let t = 20; t < 8 * 60; t += 20) {
      advance(20 * MIN);
      expect(await actorOf(r.session)).not.toBeNull();
    }
    advance(20 * MIN);
    expect(await actorOf(r.session)).toBeNull();
  });
});

// Turning paypal_outbound on needs `actor.mfa` (packages/safety/src/switches.ts, pinned by
// safety.state.test.ts). Apps/web may not import safety (Z1), so the whole of C-08 for that switch is
// the CO-G file tests/mvp-c/c08-c09-operator-headers.integration.test.ts; what this file proves is the
// flag the gate reads: the actor of a session is mfa false without a code and mfa true with one.

describe('no keys configured', () => {
  it('every operator signs in with mfa false, with or without a code or a name; refunds answer 403', async () => {
    await boot(null);
    for (const o of [
      {},
      { operator: 'vikram' },
      { operator: 'vikram', code: code(VIKRAM_B32, nowMs) },
    ]) {
      const r = await signIn(o);
      expect(r.status).toBe(200);
      expect(await actorOf(r.session)).toEqual({
        kind: 'operator',
        operator_id: 'opr_demo',
        mfa: false,
      });
      expect((await postRefund(r.session)).status).toBe(403);
    }
    const used = await app.security.db.query(
      "SELECT 1 FROM audit_log WHERE action = 'operator.totp_used'",
    );
    expect(used.rows).toHaveLength(0);
  });
});

describe('buyer and publisher sign-in are unchanged', () => {
  it('a buyer signs in with the passcode alone and has no mfa field', async () => {
    await boot();
    const res = await call(sessionRoute.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'buyer-a', passcode: PASSCODE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor_kind: string; mfa?: boolean };
    expect(body.actor_kind).toBe('buyer');
    expect(body.mfa ?? false).toBe(false);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(await app.engine.actorFromCookie(cookie)).toMatchObject({ kind: 'buyer' });
  });
  it('code and operator fields on a buyer sign-in change nothing and use nothing up', async () => {
    await boot();
    const c = code(VIKRAM_B32, nowMs);
    const res = await call(sessionRoute.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'buyer-a', passcode: PASSCODE, operator: 'vikram', code: c },
    });
    expect(res.status).toBe(200);
    expect((await signIn({ operator: 'vikram', code: c })).status).toBe(200);
  });
});

describe('config and security agree on what a key is', () => {
  // createApp loads the config and throws "boot refused: <code> <variable>" on a refusal; nothing is opened.
  const accepts = async (keys: string): Promise<boolean> => {
    try {
      createApp(await testEnv({ UMS_OPERATOR_TOTP_KEYS: keys }));
      return true;
    } catch (e) {
      expect(String(e)).toMatch(
        /^Error: boot refused: (invalid_value|weak_secret) UMS_OPERATOR_TOTP_KEYS$/,
      );
      return false;
    }
  };
  it.each([
    VIKRAM_B32,
    SAKTHI_B32,
    'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEUY=', // 19 bytes
    'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2UKVLA====', // 22 bytes
    'ifbegrcfizduqskkjngE2tspkbiveu2u',
    'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U=',
  ])(
    '%s: the config accepts it exactly when security decodes it to at least 20 bytes that are not one repeated character',
    async (b32) => {
      const bytes = base32Decode(b32);
      const usable =
        bytes !== null &&
        bytes.length >= 20 &&
        !/^(.)\1*$/.test(b32.toUpperCase().replace(/=+$/, ''));
      expect(await accepts(`vikram:${b32}`)).toBe(usable);
    },
  );
  it.each([
    'vikram',
    'sakthi',
    'a',
    'a_1',
    'Vikram',
    '1a',
    'demo',
    'a-b',
    'x'.repeat(32),
    'x'.repeat(33),
  ])('the name %s', async (name) => {
    expect(await accepts(`${name}:${VIKRAM_B32}`)).toBe(isOperatorName(name));
  });
});

describe('logs', () => {
  it('no log line holds a key or a code, and a refusal is logged with its reason', async () => {
    const lines: string[] = [];
    app = createApp(await testEnv({ UMS_OPERATOR_TOTP_KEYS: KEYS }), {
      switch_cache_ms: 0,
      log_sink: (l) => void lines.push(l),
    });
    installApp(app);
    await app.ready();
    sessionRoute = await import('./app/api/session/route');
    const c = code(VIKRAM_B32, nowMs);
    const bad = code(VIKRAM_B32, nowMs, 9);
    expect((await signIn({ operator: 'vikram', code: c })).status).toBe(200);
    expect((await signIn({ operator: 'vikram', code: c })).status).toBe(401); // replay
    expect((await signIn({ operator: 'vikram', code: bad })).status).toBe(401);
    const text = lines.join('\n');
    expect(text).toContain('operator_sign_in_refused');
    expect(text).toContain('replay');
    expect(text).toContain('wrong_code');
    for (const secret of [VIKRAM_B32, SAKTHI_B32, c, bad]) expect(text).not.toContain(secret);
  });
});
