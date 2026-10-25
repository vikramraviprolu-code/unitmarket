// MVP-C offline acceptance C-08 (operator MFA) and C-09 (headers and limits); nfr.md SOP 4, 8, 9, 10,
// 14, P9, COST-3. Everything goes through the session route, the route handlers and the page
// middleware of the real app; the operator's code is made here from a public test key. The switch-on
// check uses the public path a hosted app has: sign in through the session route, take the actor the
// app resolves from the cookie, and hand that actor to the safety package's setSwitch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditSink } from '@umsbx/obs';
import { cryptoIds, systemClock } from '@umsbx/runtime';
import { setSwitch } from '@umsbx/safety';
import { call, signIn } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import { middleware } from '../../apps/web/src/middleware';
import {
  NOW_MS,
  bootWebhookApp,
  delivery,
  eventBody,
  eventBodyOfSize,
} from '../../apps/web/src/webhook-support';
import type { WebhookRig } from '../../apps/web/src/webhook-support';
import {
  APPROVAL_REF,
  PASSCODE,
  VIKRAM_B32,
  bootRig,
  buy,
  postRefund,
  totpCode,
} from './c-support';
import type { CRig } from './c-support';

vi.mock('server-only', () => ({}));

const MIN = 60_000;
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
let hour = 0;

describe('C-08 and C-09 operator MFA, headers and limits (offline)', () => {
  let rig: CRig | null = null;
  let wrig: WebhookRig | null = null;
  let nowMs = T0;
  const setNow = (ms: number) => {
    nowMs = ms;
    vi.setSystemTime(ms);
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setNow(T0 + hour++ * 60 * MIN); // each test gets its own hour, so its own TOTP steps
  });
  afterEach(async () => {
    await rig?.close();
    await wrig?.close();
    rig = null;
    wrig = null;
    vi.useRealTimers();
  });

  const actorOf = (r: CRig, s: Session) => r.app.engine.actorFromCookie(s.cookie);

  describe('C-08 operator_mfa', () => {
    it('C-08 an operator without a code gets 403 on the refund route; with a right code the refund is allowed', async () => {
      rig = await bootRig();
      const unit = await buy(rig, { offer: 'ferry-timetables', option: 'online_read' }); // 1.25
      const body = {
        unit_id: unit.unit_id,
        amount_minor: 125,
        reason: 'C-08 refund as an operator',
      };

      // no session at all
      expect((await postRefund(rig, null, body)).status).toBe(401);

      // signed in with the passcode and no code: the unverified operator
      const plain = await call(rig.routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona: 'operator', passcode: PASSCODE },
      });
      expect(plain.status).toBe(200);
      const plainBody = (await plain.json()) as { csrf_token: string; mfa: boolean };
      expect(plainBody.mfa).toBe(false);
      const demo: Session = {
        cookie: (plain.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: plainBody.csrf_token,
      };
      expect(await actorOf(rig, demo)).toEqual({
        kind: 'operator',
        operator_id: 'opr_demo',
        mfa: false,
      });
      const refused = await postRefund(rig, demo, body);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'mfa_required',
      );
      expect(await rig.count('SELECT count(*) AS c FROM refund_requests')).toBe(0);
      expect(rig.ops()).not.toContain('refund_capture');

      // a wrong code is a plain sign-in failure and leaves no session
      const wrong = await call(rig.routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: {
          persona: 'operator',
          passcode: PASSCODE,
          operator: 'vikram',
          code: totpCode(VIKRAM_B32, nowMs, 9),
        },
      });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('set-cookie')).toBeNull();

      // with a right code: mfa true, the refund runs
      const op = await rig.operator('vikram', nowMs);
      expect(await actorOf(rig, op)).toEqual({
        kind: 'operator',
        operator_id: 'opr_vikram',
        mfa: true,
      });
      const allowed = await postRefund(rig, op, body);
      expect(allowed.status).toBe(200);
      expect(await rig.count('SELECT count(*) AS c FROM refund_requests')).toBe(1);
      expect(rig.ops()).toContain('refund_capture');
    });

    it('C-08 an operator session ends after 30 minutes idle and after 8 hours, and a code works once', async () => {
      rig = await bootRig();
      const op = await rig.operator('vikram', nowMs);
      const probe = () =>
        postRefund(rig!, op, { unit_id: 'oru_nope', amount_minor: 10, reason: 'C-08 idle probe' });
      expect((await probe()).status).toBe(409); // signed in, allowed to try, nothing to refund
      setNow(nowMs + 29 * MIN);
      expect((await probe()).status).toBe(409);
      setNow(nowMs + 29 * MIN); // 58 minutes after sign-in, 29 after the last use
      expect((await probe()).status).toBe(409);
      setNow(nowMs + 31 * MIN); // idle for 31 minutes
      expect((await probe()).status).toBe(401);
      expect(await actorOf(rig, op)).toBeNull();

      // the same code again is a replay
      const replay = await call(rig.routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: {
          persona: 'operator',
          passcode: PASSCODE,
          operator: 'vikram',
          code: totpCode(VIKRAM_B32, T0 + (hour - 1) * 60 * MIN),
        },
      });
      expect(replay.status).toBe(401);

      // absolute end: signed in again, used every 20 minutes, ended at 8 hours
      setNow(nowMs + 60 * MIN);
      const again = await rig.operator('sakthi', nowMs);
      for (let t = 20; t < 8 * 60; t += 20) {
        setNow(nowMs + 20 * MIN);
        expect(await actorOf(rig, again)).not.toBeNull();
      }
      setNow(nowMs + 20 * MIN);
      expect(await actorOf(rig, again)).toBeNull();
    });

    it('C-08 switching paypal_outbound on without MFA is refused through the public path; with MFA and an active approval it works', async () => {
      rig = await bootRig();
      const audit = createAuditSink(cryptoIds(), systemClock());
      const sw = async (): Promise<boolean> =>
        (
          await rig!.app.db.query<{ on: boolean }>(
            `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
          )
        ).rows[0]!.on;
      expect(await sw()).toBe(true); // the rig starts with the owner's switch on

      // the Stop button (an operator without MFA may press it) turns it off through the route
      const plain = await call(rig.routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona: 'operator', passcode: PASSCODE },
      });
      const plainBody = (await plain.json()) as { csrf_token: string };
      const demo: Session = {
        cookie: (plain.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: plainBody.csrf_token,
      };
      const stop = await import('../../apps/web/src/app/api/ops/stop/route');
      const stopped = await call(stop.POST, {
        url: '/api/ops/stop',
        method: 'POST',
        body: { reason: 'C-08 stop' },
        session: demo,
      });
      expect(stopped.status).toBe(200);
      expect(await sw()).toBe(false);

      // the actor the app resolves for that session may not switch it back on
      const demoActor = (await actorOf(rig, demo))!;
      expect(demoActor).toMatchObject({ kind: 'operator', mfa: false });
      const refused = await setSwitch(rig.app.db, audit, systemClock(), {
        name: 'paypal_outbound',
        on: true,
        by: demoActor,
        reason: 'C-08 switch on without a second factor',
        approval_ref: APPROVAL_REF,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBe('operator_required');
      expect(await sw()).toBe(false);
      expect(
        await rig.count(
          `SELECT count(*) AS c FROM audit_log WHERE action = 'switch.paypal_outbound.on'`,
        ),
      ).toBe(0);

      // a buyer session can not either
      const buyerSession = (await signIn(rig.routes.session.POST, 'buyer-a'))!;
      const buyerActor = (await actorOf(rig, buyerSession))!;
      const asBuyer = await setSwitch(rig.app.db, audit, systemClock(), {
        name: 'paypal_outbound',
        on: true,
        by: buyerActor,
        reason: 'C-08 switch on as a buyer',
        approval_ref: APPROVAL_REF,
      });
      expect(asBuyer.ok).toBe(false);
      expect(await sw()).toBe(false);

      // with a right code the actor carries MFA, but an approval that is not active still refuses
      const op = await rig.operator('vikram', nowMs);
      const opActor = (await actorOf(rig, op))!;
      expect(opActor).toMatchObject({ kind: 'operator', mfa: true });
      const noApproval = await setSwitch(rig.app.db, audit, systemClock(), {
        name: 'paypal_outbound',
        on: true,
        by: opActor,
        reason: 'C-08 switch on with the wrong approval',
        approval_ref: 'DL-0000-00-00-none',
      });
      expect(noApproval.ok).toBe(false);
      if (!noApproval.ok) expect(noApproval.error).toBe('approval_not_active');
      expect(await sw()).toBe(false);

      const on = await setSwitch(rig.app.db, audit, systemClock(), {
        name: 'paypal_outbound',
        on: true,
        by: opActor,
        reason: 'C-08 switch on with MFA and the approval',
        approval_ref: APPROVAL_REF,
      });
      expect(on.ok).toBe(true);
      expect(await sw()).toBe(true);
      const row = await rig.app.db.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit_log WHERE action = 'switch.paypal_outbound.on'`,
      );
      expect(row.rows.map((r) => r.actor_id)).toEqual(['opr_vikram']);
    });
  });

  describe('C-09 headers_and_limits', () => {
    const must = (
      h: Headers | Record<string, string>,
      nonceOf?: (csp: string) => unknown,
    ): void => {
      const get = (k: string) => (h instanceof Headers ? h.get(k) : (h[k] ?? null));
      expect(get('strict-transport-security') ?? get('Strict-Transport-Security')).toMatch(
        /max-age=\d{7,}/,
      );
      const csp = get('content-security-policy') ?? get('Content-Security-Policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9_-]{16,}'/);
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(get('x-content-type-options') ?? get('X-Content-Type-Options')).toBe('nosniff');
      expect(get('referrer-policy') ?? get('Referrer-Policy')).toBe(
        'strict-origin-when-cross-origin',
      );
      if (nonceOf) nonceOf(csp);
    };

    it('C-09 pages carry HSTS, a CSP with a fresh nonce and frame-ancestors none, nosniff and a Referrer-Policy', async () => {
      const nonces = new Set<string>();
      for (const path of ['/', '/library', '/ops', '/checkout/return']) {
        const res = middleware(new Request(`http://localhost:3000${path}`) as never);
        must(res.headers, (csp) => nonces.add(/nonce-([A-Za-z0-9_-]+)/.exec(csp)![1]!));
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(res.headers.get('permissions-policy')).toContain('payment=()');
      }
      expect(nonces.size).toBe(4);
    });

    it('C-09 route handlers carry the same headers on success and on refusal, with a fresh nonce each time', async () => {
      rig = await bootRig();
      const nonces = new Set<string>();
      const grab = (csp: string) => nonces.add(/nonce-([A-Za-z0-9_-]+)/.exec(csp)![1]!);
      const ok = await call(rig.routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona: 'buyer-a', passcode: PASSCODE },
      });
      expect(ok.status).toBe(200);
      must(ok.headers, grab);
      const bad = await call(rig.routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona: 'buyer-a', passcode: 'nope' },
      });
      expect(bad.status).toBe(401);
      must(bad.headers, grab);
      const unauth = await call(rig.routes.library.GET, { url: '/api/library' });
      expect(unauth.status).toBe(401);
      must(unauth.headers, grab);
      const hook = await rig.post(delivery(eventBody({ id: 'WH-C09' }), { id: 'TR-C09' }));
      must(hook.headers, grab);
      expect(nonces.size).toBe(4);
    });

    it('C-09 a body over 64 KB is 413 on the webhook route and on a JSON route, and nothing is stored', async () => {
      setNow(NOW_MS);
      wrig = await bootWebhookApp();
      const big = delivery(eventBodyOfSize({ id: 'WH-C09-BIG' }, 65_537), { id: 'TR-C09-BIG' });
      expect(Buffer.byteLength(big.raw_body)).toBe(65_537);
      const res = await wrig.post(big);
      expect(res.status).toBe(413);
      must(res.headers);
      expect(await wrig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
      expect(wrig.certs?.calls).toEqual([]);

      const session = await import('../../apps/web/src/app/api/session/route');
      const huge = await call(session.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona: 'buyer-a', passcode: 'x'.repeat(70_000) },
      });
      expect(huge.status).toBe(413);
      expect(await wrig.count('SELECT count(*) AS c FROM sessions')).toBe(0);
    });

    it('C-09 the COST-3 limits answer 429 with Retry-After: sign-in 5 per 15 min, approve 10 per hour, ask 20 per hour, download 60 per hour', async () => {
      rig = await bootRig();
      const buyer = (await signIn(rig.routes.session.POST, 'buyer-a'))!;
      const hit = async (
        handler: Parameters<typeof call>[0],
        o: Parameters<typeof call>[1],
        n: number,
      ): Promise<number[]> => {
        const codes: number[] = [];
        for (let i = 0; i < n; i++) codes.push((await call(handler, o)).status);
        return codes;
      };
      const limited = async (
        handler: Parameters<typeof call>[0],
        o: Parameters<typeof call>[1],
        limit: number,
      ) => {
        const first = await hit(handler, o, limit);
        expect(first.every((c) => c !== 429)).toBe(true);
        const over = await call(handler, o);
        expect(over.status).toBe(429);
        expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(((await over.json()) as { error: { code: string } }).error.code).toBe(
          'rate_limited',
        );
      };

      // approve: 10 per hour per user
      const approvals = await import('../../apps/web/src/app/api/approvals/route');
      await limited(
        approvals.POST,
        { url: '/api/approvals', method: 'POST', body: {}, session: buyer },
        10,
      );
      // ask: 20 per hour per user
      const briefs = await import('../../apps/web/src/app/api/briefs/route');
      await limited(
        briefs.POST,
        { url: '/api/briefs', method: 'POST', body: { need: 'tide tables' }, session: buyer },
        20,
      );
      // download: 60 per hour per user
      await limited(
        rig.routes.link.POST,
        {
          url: '/api/library/ent_none/link',
          method: 'POST',
          body: {},
          session: buyer,
          params: { id: 'ent_none' },
        },
        60,
      );
      // sign-in: 5 wrong passcodes per 15 minutes from one address
      await limited(
        rig.routes.session.POST,
        {
          url: '/api/session',
          method: 'POST',
          body: { persona: 'buyer-b', passcode: 'not the passcode' },
          headers: { 'x-forwarded-for': '198.18.0.1, 203.0.113.77' },
        },
        5,
      );
    }, 60_000);

    it('C-09 invalid webhook deliveries are limited to 60 a minute per address; a valid delivery from another address is never dropped', async () => {
      setNow(NOW_MS);
      wrig = await bootWebhookApp();
      const bad = (i: number) =>
        delivery(eventBody({ id: `WH-C09-L${i}` }), {
          id: `TR-C09-L${i}`,
          webhook_id: 'OTHER-WEBHOOK-ID',
        });
      const ip = '203.0.113.200';
      const codes: number[] = [];
      for (let i = 0; i < 60; i++) codes.push((await wrig.post(bad(i), { ip })).status);
      expect(codes.every((c) => c === 400)).toBe(true);
      const over = await wrig.post(bad(60), { ip });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      // PayPal's own address is another bucket: a valid delivery is answered 200
      const valid = delivery(eventBody({ id: 'WH-C09-OK' }), { id: 'TR-C09-OK' });
      expect((await wrig.post(valid, { ip: '203.0.113.201' })).status).toBe(200);
      expect(await wrig.count('SELECT count(*) AS c FROM webhook_events')).toBe(1);
    }, 60_000);
  });
});
