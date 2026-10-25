// CO-8 adversarial (docs/specs/web-refund-states.md): the operator money route under attack. A missing
// CSRF token, a foreign Origin, a string or negative or fractional amount, an amount over what is left,
// a stopped session, another operator's token, a forged second factor, the switch off, the kill switch
// off, and many requests at once: none moves more money than asked, and nothing leaks.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { revokeAllSessions } from '@umsbx/security';
import { SESSION_IDLE_MS } from '@umsbx/security';
import { PASSCODE, ORIGIN, call } from './support';
import {
  postRefund,
  providerCalls,
  refundRows,
  errorOf,
  buy,
  ledgerRefunds,
  unitStatus,
  bootRefundWorld,
} from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
const logs: string[] = [];
const u: Record<string, BoughtUnit> = {};

beforeAll(async () => {
  w = await bootRefundWorld({}, { log_sink: (l) => logs.push(l) });
  u['a'] = await buy(w, { offer: 'knot-notebook', option: 'online_read' }); // A 4.50
  u['b'] = await buy(w, { offer: 'harbour-fees', option: 'online_read' }); // A 2.50
  u['c'] = await buy(w, { offer: 'ferry-timetables', option: 'online_read' }); // A 1.25
  u['d'] = await buy(w, { offer: 'tide-tables', option: 'online_read' }); // A 0.40
  u['e'] = await buy(w, { offer: 'tide-tables', option: 'online_read', who: 'B' }); // B 0.40
});
afterAll(async () => {
  await w.app.close();
});
afterEach(() => {
  vi.useRealTimers();
});

const ask = (unit: BoughtUnit, amount_minor: unknown, extra: Record<string, unknown> = {}) => ({
  unit_id: unit.unit_id,
  amount_minor,
  reason: 'Adversarial test refund',
  ...extra,
});

describe('CSRF and Origin', () => {
  it('a missing CSRF token is 403 csrf and stores nothing', async () => {
    const res = await postRefund(w, w.op, ask(u['a']!, 100), { csrf: false });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('csrf');
    expect(await refundRows(w.app)).toBe(0);
  });
  it('a wrong CSRF token, a foreign Origin and no Origin are 403', async () => {
    const wrong = await postRefund(w, w.op, ask(u['a']!, 100), {
      headers: { 'x-csrf-token': 'x'.repeat(40) },
      csrf: false,
    });
    expect(wrong.status).toBe(403);
    // call() sets Origin itself, so the foreign and the missing Origin are built by hand
    const req = new Request(`${ORIGIN}/api/refunds`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        cookie: w.op.cookie,
        'x-csrf-token': w.op.csrf,
        'content-type': 'application/json',
        'idempotency-key': 'foreign-origin-2',
      },
      body: JSON.stringify(ask(u['a']!, 100)),
    });
    expect((await w.refunds.POST(req)).status).toBe(403);
    const none = new Request(`${ORIGIN}/api/refunds`, {
      method: 'POST',
      headers: {
        cookie: w.op.cookie,
        'x-csrf-token': w.op.csrf,
        'content-type': 'application/json',
        'idempotency-key': 'no-origin-0001',
      },
      body: JSON.stringify(ask(u['a']!, 100)),
    });
    expect((await w.refunds.POST(none)).status).toBe(403);
    expect(await refundRows(w.app)).toBe(0);
  });
  it('a GET answers 404, the route has no GET', async () => {
    const res = await call(w.refunds.POST, { url: '/api/refunds', method: 'GET', session: w.op });
    expect(res.status).toBe(404);
  });
});

describe('the amount', () => {
  const bad: [string, unknown][] = [
    ['a string', '100'],
    ['a decimal string', '1.00'],
    ['negative', -100],
    ['zero', 0],
    ['fractional', 1.5],
    ['a boolean', true],
    ['an array', [100]],
    ['an object', { minor: 100 }],
    ['past the safe integers', 1e21],
    ['past the route cap', 100_000_001],
  ];
  for (const [name, amount] of bad) {
    it(`${name} is refused with 422 and nothing is stored or sent`, async () => {
      const res = await postRefund(w, w.op, ask(u['a']!, amount));
      expect(res.status).toBe(422);
      expect(await refundRows(w.app)).toBe(0);
      expect(await providerCalls(w.app, 'refund_capture')).toBe(0);
    });
  }
  it('an amount over what is left is 409 over_refund, one cent over included', async () => {
    const over = await postRefund(w, w.op, ask(u['a']!, 451));
    expect(over.status).toBe(409);
    expect((await errorOf(over)).code).toBe('over_refund');
    expect(await refundRows(w.app)).toBe(0);
  });
  it('the exact amount left is allowed; one cent more after that is not', async () => {
    const unit = u['e']!; // 0.40
    expect((await postRefund(w, w.op, ask(unit, 40))).status).toBe(200);
    const more = await postRefund(w, w.op, ask(unit, 1));
    expect(more.status).toBe(409);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(40);
  });
  it('two partial refunds that together pass the total: the second is refused', async () => {
    const unit = u['b']!; // 2.50
    expect((await postRefund(w, w.op, ask(unit, 150))).status).toBe(200);
    const second = await postRefund(w, w.op, ask(unit, 101));
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe('over_refund');
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(150);
  });
  it('a stale page: an amount that fitted when the page was drawn is refused after the money moved', async () => {
    const unit = u['d']!; // 0.40
    const drawn = 40; // what the page showed as left
    expect((await postRefund(w, w.op, ask(unit, 30))).status).toBe(200); // a second tab refunds 0.30
    const stale = await postRefund(w, w.op, ask(unit, drawn));
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).message).toMatch(/nothing was refunded/i);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(30);
  });
  it('an id that looks like SQL is just an unknown unit', async () => {
    const res = await postRefund(w, w.op, {
      unit_id: "x' OR '1'='1",
      amount_minor: 10,
      reason: 'injection attempt',
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_captured');
  });
});

describe('sessions', () => {
  it('a revoked (stopped) session is refused with 401 and nothing happens', async () => {
    const { createSession } = await import('@umsbx/security');
    const s = await createSession(w.app.security, {
      kind: 'operator',
      operator_id: 'opr_gone',
      mfa: true,
    });
    const session = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    await revokeAllSessions(w.app.security, {
      kind: 'operator',
      operator_id: 'opr_gone',
      mfa: true,
    });
    const res = await postRefund(w, session, ask(u['c']!, 50));
    expect(res.status).toBe(401);
    expect(await refundRows(w.app, u['c']!.unit_id)).toBe(0);
  });
  it('an idle session (30 minutes) is refused with 401', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2030-01-01T12:00:00.000Z');
    vi.setSystemTime(start);
    const { createSession } = await import('@umsbx/security');
    const s = await createSession(w.app.security, {
      kind: 'operator',
      operator_id: 'opr_idle',
      mfa: true,
    });
    const session = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    vi.setSystemTime(start + SESSION_IDLE_MS + 1000);
    const res = await postRefund(w, session, ask(u['c']!, 50));
    expect(res.status).toBe(401);
    expect(await refundRows(w.app, u['c']!.unit_id)).toBe(0);
  });
  it('one operator’s cookie with another operator’s CSRF token is 403', async () => {
    const res = await call(w.refunds.POST, {
      url: '/api/refunds',
      method: 'POST',
      body: ask(u['c']!, 50),
      session: { cookie: w.op.cookie, csrf: w.op2.csrf },
      headers: { 'idempotency-key': 'cross-operator-1' },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('csrf');
    expect(await refundRows(w.app, u['c']!.unit_id)).toBe(0);
  });
  it('a forged cookie signature is 401', async () => {
    const bad = {
      cookie: w.op.cookie.replace(/\.[A-Za-z0-9_-]{43}$/, `.${'A'.repeat(43)}`),
      csrf: w.op.csrf,
    };
    expect(bad.cookie).not.toBe(w.op.cookie);
    expect((await postRefund(w, bad, ask(u['c']!, 50))).status).toBe(401);
  });
  it('the unverified operator stays without the second factor, whatever its session says', async () => {
    const { createSession } = await import('@umsbx/security');
    const s = await createSession(w.app.security, {
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: true,
    });
    const res = await postRefund(
      w,
      { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token },
      ask(u['c']!, 50),
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
    expect(await refundRows(w.app, u['c']!.unit_id)).toBe(0);
  });
  it('a buyer session cannot refund their own purchase', async () => {
    const res = await postRefund(w, w.A, ask(u['c']!, 50));
    expect(res.status).toBe(403);
    expect(await refundRows(w.app, u['c']!.unit_id)).toBe(0);
  });
});

describe('the switches', () => {
  it('refunds_enabled off: 503 "Refunds paused", no request, no provider call', async () => {
    await w.app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'refunds_enabled'`);
    try {
      const calls = await providerCalls(w.app, 'refund_capture');
      const res = await postRefund(w, w.op, ask(u['c']!, 50));
      expect(res.status).toBe(503);
      expect((await errorOf(res)).message).toContain('Refunds paused');
      expect(await refundRows(w.app, u['c']!.unit_id)).toBe(0);
      expect(await providerCalls(w.app, 'refund_capture')).toBe(calls);
    } finally {
      await w.app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'refunds_enabled'`);
    }
  });
  it('the kill switch off: nothing is sent blind; the answer says it is not confirmed and the request is not lost', async () => {
    const unit = u['c']!;
    await w.app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'paypal_outbound'`);
    try {
      const calls = await providerCalls(w.app, 'refund_capture');
      const res = await postRefund(w, w.op, ask(unit, 50));
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ state: 'unknown' });
      expect(await providerCalls(w.app, 'refund_capture')).toBe(calls);
      expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(0);
      expect(await unitStatus(w.app, unit.unit_id)).toBe('captured_verified');
      // the request is still open, so a second click cannot send a second one
      const again = await postRefund(w, w.op, ask(unit, 50));
      expect(again.status).toBe(409);
      expect((await errorOf(again)).code).toBe('refund_in_flight');
    } finally {
      await w.app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
    }
  });
});

describe('many at once', () => {
  it('ten refunds of the rest with ten keys make exactly one provider call and one ledger entry', async () => {
    const unit = await buy(w, { offer: 'ferry-timetables', option: 'online_read', who: 'B' }); // 1.25
    const before = await providerCalls(w.app, 'refund_capture');
    const all = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postRefund(
          w,
          w.op,
          { unit_id: unit.unit_id, amount_minor: null, reason: 'Race to refund the rest' },
          { key: `race-key-${i}-abcdefgh` },
        ),
      ),
    );
    const statuses = all.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    for (const s of statuses.filter((s) => s !== 200)) expect(s).toBe(409);
    expect(await providerCalls(w.app, 'refund_capture')).toBe(before + 1);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(125);
    expect(await unitStatus(w.app, unit.unit_id)).toBe('refunded');
  });
  it('ten sends of one key give one refund; the rest are the stored answer or 409 in_progress', async () => {
    const unit = await buy(w, { offer: 'harbour-fees', option: 'online_read', who: 'B' }); // 2.50
    const before = await providerCalls(w.app, 'refund_capture');
    const all = await Promise.all(
      Array.from({ length: 10 }, () =>
        postRefund(w, w.op, ask(unit, 10), { key: 'same-key-for-all-ten' }),
      ),
    );
    for (const r of all) expect([200, 409]).toContain(r.status);
    expect(all.some((r) => r.status === 200)).toBe(true);
    expect(await providerCalls(w.app, 'refund_capture')).toBe(before + 1);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(10);
  });
});

describe('no secrets in logs or the audit log', () => {
  it('no log line or audit row carries a cookie, a CSRF token, the passcode, the TOTP key or the reason text', async () => {
    const unit = await buy(w, { offer: 'knot-notebook', option: 'keep_retrieve', who: 'B' });
    const reason = 'Secret-looking reason zq81xk';
    await postRefund(w, w.op, { unit_id: unit.unit_id, amount_minor: 50, reason });
    const log = logs.join('\n');
    for (const secret of [
      w.op.cookie,
      w.op.csrf,
      w.demo.csrf,
      w.A.cookie,
      PASSCODE,
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      reason,
    ]) {
      expect(log.includes(secret), secret.slice(0, 12)).toBe(false);
    }
    const audit = JSON.stringify((await w.app.db.query('SELECT * FROM audit_log')).rows);
    for (const secret of [w.op.cookie, w.op.csrf, PASSCODE, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ']) {
      expect(audit.includes(secret)).toBe(false);
    }
    // the reason itself is in the audit row (it is the operator's own statement), and nowhere else
    expect(audit.includes(reason)).toBe(true);
  });
});

describe('another buyer’s refund', () => {
  it('buyer B cannot read buyer A’s receipt or order, and the library of B lists none of A’s items', async () => {
    const unit = u['a']!;
    await postRefund(w, w.op, ask(unit, 100));
    const rcpt = await call(w.receipts.GET, {
      url: `/api/receipts/${unit.order_id}`,
      session: w.B,
      params: { order: unit.order_id },
    });
    expect(rcpt.status).toBe(404);
    const lib = (await (
      await call(w.library.GET, { url: '/api/library', session: w.B })
    ).json()) as { items: { entitlement_id: string }[] };
    expect(lib.items.some((i) => i.entitlement_id === unit.entitlement_id)).toBe(false);
  });
});
