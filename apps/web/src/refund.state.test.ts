// CO-8 state tests (docs/specs/web-refund-states.md): the operator refund route over the real payments
// engine and the dry-run order model. The route is an operator POST with CSRF and an Idempotency-Key.
// It refuses an operator without the second factor (403), a buyer (403, the same for any unit id: no
// existence oracle), calls requestRefund then executeRefund, and says every refusal in plain words.
// A replay of the same key returns the stored answer and makes no second request.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bootRefundWorld,
  buy,
  count,
  errorOf,
  ledgerRefunds,
  postCancel,
  postRefund,
} from './refund-support';
import { providerCalls, refundRows, unitStatus } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
// Units are bought once, one per test that changes money, so tests never share a unit.
const u: Record<string, BoughtUnit> = {};

beforeAll(async () => {
  w = await bootRefundWorld();
  // Only four offers are open to a USD buyer, and a buyer owns an article once: four units each.
  u['main'] = await buy(w, { offer: 'knot-notebook', option: 'online_read' }); // A 4.50
  u['nomfa'] = await buy(w, { offer: 'tide-tables', option: 'online_read' }); // A 0.40
  u['replay'] = await buy(w, { offer: 'ferry-timetables', option: 'online_read' }); // A 1.25
  u['over'] = await buy(w, { offer: 'harbour-fees', option: 'online_read' }); // A 2.50
  u['flight'] = await buy(w, { offer: 'knot-notebook', option: 'online_read', who: 'B' }); // B 4.50
  u['frozen'] = await buy(w, { offer: 'ferry-timetables', option: 'online_read', who: 'B' }); // B 1.25
  u['valid'] = await buy(w, { offer: 'harbour-fees', option: 'online_read', who: 'B' }); // B 2.50
});
afterAll(async () => {
  await w.app.close();
});

const body = (
  unit: BoughtUnit,
  amount_minor: number | null,
  reason = 'Customer asked for a refund',
) => ({
  unit_id: unit.unit_id,
  amount_minor,
  reason,
});

describe('who may refund', () => {
  it('an operator without the second factor gets 403 mfa_required and nothing is stored', async () => {
    const res = await postRefund(w, w.demo, body(u['nomfa']!, 100));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
    expect(await refundRows(w.app, u['nomfa']!.unit_id)).toBe(0);
    expect(await providerCalls(w.app, 'refund_capture')).toBe(0);
    expect(await unitStatus(w.app, u['nomfa']!.unit_id)).toBe('captured_verified');
  });

  it('no session gives 401, and a buyer gets 403 forbidden', async () => {
    expect((await postRefund(w, null, body(u['nomfa']!, 100))).status).toBe(401);
    const res = await postRefund(w, w.A, body(u['nomfa']!, 100));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
    expect(await refundRows(w.app, u['nomfa']!.unit_id)).toBe(0);
  });

  it('a buyer learns nothing about a unit: the answer is the same for a real and an unknown unit id', async () => {
    const real = await postRefund(w, w.A, body(u['nomfa']!, 100));
    const fake = await postRefund(w, w.A, {
      unit_id: 'oru_does_not_exist',
      amount_minor: 100,
      reason: 'probe attempt',
    });
    expect(real.status).toBe(fake.status);
    const [a, b] = [await errorOf(real), await errorOf(fake)];
    expect([a.code, a.message]).toEqual([b.code, b.message]);
  });

  it('the other buyer cannot refund the first buyer’s unit either', async () => {
    const res = await postRefund(w, w.B, body(u['nomfa']!, 100));
    expect(res.status).toBe(403);
    expect(await refundRows(w.app)).toBe(0);
  });
});

describe('a replayed Idempotency-Key', () => {
  it('returns the stored answer and makes one request, one provider call and one ledger entry', async () => {
    const unit = u['replay']!;
    const first = await postRefund(w, w.op, body(unit, 50), { key: 'replay-key-0001' });
    expect(first.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    expect(a['state']).toBe('completed');
    expect(a['amount_minor']).toBe(50);
    const second = await postRefund(w, w.op, body(unit, 50), { key: 'replay-key-0001' });
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(await second.json()).toEqual(a);
    expect(await refundRows(w.app, unit.unit_id)).toBe(1);
    expect(await providerCalls(w.app, 'refund_capture')).toBe(1);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(50);
  });

  it('the same key with another amount is 422 idempotency_key_reused and refunds nothing', async () => {
    const unit = u['replay']!;
    const res = await postRefund(w, w.op, body(unit, 60), { key: 'replay-key-0001' });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('idempotency_key_reused');
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(50);
  });

  it('a refund without an Idempotency-Key is 422 and nothing is stored', async () => {
    const before = await refundRows(w.app);
    const res = await postRefund(w, w.op, body(u['replay']!, 10), { key: null });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('idempotency_key');
    expect(await refundRows(w.app)).toBe(before);
  });

  it('a refused attempt does not keep its key: the same key can be used again once the cause is fixed', async () => {
    const unit = u['over']!; // 2.50
    const refused = await postRefund(w, w.op, body(unit, 251), { key: 'retry-key-0001' });
    expect(refused.status).toBe(409);
    const ok = await postRefund(w, w.op, body(unit, 250), { key: 'retry-key-0001' });
    // the body changed, so this is a new request under a key that was released, not a replay
    expect(ok.status).toBe(200);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(250);
  });
});

describe('refusals are plain', () => {
  it('over-refund is 409 over_refund with a plain message and stores no request', async () => {
    const unit = u['main']!; // 4.50
    const res = await postRefund(w, w.op, body(unit, 451));
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e.code).toBe('over_refund');
    expect(e.message).toMatch(/more than is left to refund/i);
    expect(e.message).toMatch(/nothing was refunded/i);
    expect(await refundRows(w.app, unit.unit_id)).toBe(0);
  });

  it('a unit that was never captured, and an unknown unit, are 409 not_captured', async () => {
    const unknown = await postRefund(w, w.op, {
      unit_id: 'oru_nope',
      amount_minor: 10,
      reason: 'no such unit',
    });
    expect(unknown.status).toBe(409);
    expect((await errorOf(unknown)).code).toBe('not_captured');
    const pending = await buy(w, {
      offer: 'tide-tables',
      option: 'online_read',
      scenario: 'pending_receiving_pref',
      who: 'B',
    });
    expect(await unitStatus(w.app, pending.unit_id)).toBe('pending');
    const res = await postRefund(w, w.op, body(pending, 10));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_captured');
    expect(await refundRows(w.app, pending.unit_id)).toBe(0);
  });

  it('refund_in_flight: one open request per unit; it says wait or withdraw', async () => {
    const unit = u['flight']!;
    const id = await openRequest(unit, 25);
    const calls = await providerCalls(w.app, 'refund_capture');
    const res = await postRefund(w, w.op, body(unit, 25));
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e.code).toBe('refund_in_flight');
    expect(e.message).toMatch(/wait/i);
    expect(e.message).toMatch(/withdraw/i);
    expect(await providerCalls(w.app, 'refund_capture')).toBe(calls);
    expect(await refundRows(w.app, unit.unit_id)).toBe(1);
    // the cancel path clears it
    const cancelled = await postCancel(w, w.op, id);
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { state: string }).state).toBe('cancelled');
    const again = await postRefund(w, w.op, body(unit, 25));
    expect(again.status).toBe(200);
  });

  it('unit_frozen: a flagged payment takes no request, says a person must look, and access is unchanged', async () => {
    const unit = u['frozen']!;
    await w.app.db.query('UPDATE orders SET mismatch = true WHERE id = $1', [unit.order_id]);
    const res = await postRefund(w, w.op, body(unit, 50));
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e.code).toBe('unit_frozen');
    expect(e.message).toMatch(/a person must look/i);
    expect(e.message).toMatch(/access is unchanged/i);
    expect(await refundRows(w.app, unit.unit_id)).toBe(0);
    const lib = await w.app.engine.libraryItem({
      entitlement_id: unit.entitlement_id,
      actor: w.actorB,
    });
    expect(lib?.can_open).toBe(true);
  });

  it('refunds_enabled off gives 503 "Refunds paused" and stores nothing; on again it works', async () => {
    const unit = u['valid']!;
    await w.app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'refunds_enabled'`);
    const res = await postRefund(w, w.op, body(unit, 10));
    expect(res.status).toBe(503);
    const e = await errorOf(res);
    expect(e.code).toBe('refunds_paused');
    expect(e.message).toContain('Refunds paused');
    expect(await refundRows(w.app, unit.unit_id)).toBe(0);
    await w.app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'refunds_enabled'`);
    expect((await postRefund(w, w.op, body(unit, 10))).status).toBe(200);
  });
});

describe('the input is strict', () => {
  const bad: [string, unknown][] = [
    [
      'no amount_minor key (the amount must be named, or null for the rest)',
      { unit_id: 'x', reason: 'valid reason' },
    ],
    ['no reason', { unit_id: 'x', amount_minor: 10 }],
    ['a reason of two characters', { unit_id: 'x', amount_minor: 10, reason: 'ab' }],
    ['a reason of 201 characters', { unit_id: 'x', amount_minor: 10, reason: 'r'.repeat(201) }],
    ['an extra field', { unit_id: 'x', amount_minor: 10, reason: 'valid reason', note: 'x' }],
    ['no unit_id', { amount_minor: 10, reason: 'valid reason' }],
  ];
  for (const [name, payload] of bad) {
    it(`refuses ${name} with 422`, async () => {
      const before = await refundRows(w.app);
      const res = await postRefund(w, w.op, payload);
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe('invalid_input');
      expect(await refundRows(w.app)).toBe(before);
    });
  }
  it('accepts a reason of 3 and of 200 characters', async () => {
    const unit = u['main']!;
    const short = await postRefund(w, w.op, body(unit, 1, 'abc'));
    expect(short.status).toBe(200);
    const long = await postRefund(w, w.op, body(unit, 1, 'r'.repeat(200)));
    expect(long.status).toBe(200);
  });
});

describe('the cancel path', () => {
  it('withdraws a request that is still requested, also while refunds are paused', async () => {
    const fresh = u['nomfa']!; // 0.40, untouched until now
    const id = await openRequest(fresh, 30);
    await w.app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'refunds_enabled'`);
    const res = await postCancel(w, w.op, id);
    expect(res.status).toBe(200);
    await w.app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'refunds_enabled'`);
    const row = await w.app.db.query<{ state: string }>(
      'SELECT state FROM refund_requests WHERE id = $1',
      [id],
    );
    expect(row.rows[0]?.state).toBe('cancelled');
    expect(
      await count(w.app, "SELECT count(*) AS c FROM audit_log WHERE action = 'refund.cancelled'"),
    ).toBeGreaterThanOrEqual(1);
  });

  it('any other state answers 409 wrong_state; an unknown id 404; no second factor 403', async () => {
    const done = await w.app.db.query<{ id: string }>(
      "SELECT id FROM refund_requests WHERE state = 'completed' LIMIT 1",
    );
    const wrong = await postCancel(w, w.op, done.rows[0]!.id);
    expect(wrong.status).toBe(409);
    expect((await errorOf(wrong)).code).toBe('wrong_state');
    const gone = await postCancel(w, w.op, 'rfr_not_there');
    expect(gone.status).toBe(404);
    const nomfa = await postCancel(w, w.demo, done.rows[0]!.id);
    expect(nomfa.status).toBe(403);
    expect((await errorOf(nomfa)).code).toBe('mfa_required');
    expect((await postCancel(w, w.A, done.rows[0]!.id)).status).toBe(403);
  });

  it('the case resolver can undo its own requests: cancelRefund is wired beside requestRefund', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../composition.server.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/cancelRefund\s*:/);
    expect(src).toMatch(/cancelRefundRequest/);
  });
});

describe('every attempt is audited without secrets', () => {
  it('writes one refund.attempt row per attempt that reached the handler, with the outcome and no secret', async () => {
    const rows = await w.app.db.query<{
      actor_id: string;
      target: string | null;
      reason: string | null;
      detail: Record<string, unknown>;
    }>(
      "SELECT actor_id, target, reason, detail FROM audit_log WHERE action = 'refund.attempt' ORDER BY created_at, id",
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(8);
    const outcomes = new Set(rows.rows.map((r) => r.detail['outcome']));
    for (const o of [
      'refunded',
      'over_refund',
      'refund_in_flight',
      'unit_frozen',
      'refunds_off',
      'not_captured',
    ])
      expect(outcomes.has(o), o).toBe(true);
    for (const r of rows.rows) {
      expect(r.actor_id).toMatch(/^opr_/);
      expect(r.detail['actor_mfa']).toBe(true);
    }
    const dump = JSON.stringify((await w.app.db.query('SELECT * FROM audit_log')).rows);
    for (const secret of [w.op.cookie, w.op.csrf, w.A.cookie, w.A.csrf, w.demo.csrf]) {
      expect(dump.includes(secret)).toBe(false);
    }
  });
});

describe('the ops view is for second-factor sessions only', () => {
  it('opsSnapshot carries the refundable units for an mfa operator and none for the unverified one', async () => {
    const withMfa = await w.app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    });
    const without = await w.app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(without?.refunds).toBeNull();
    expect(withMfa?.refunds).not.toBeNull();
    const main = withMfa!.refunds!.units.find((x) => x.unit_id === u['main']!.unit_id)!;
    expect(main.amount_minor).toBe(450);
    expect(main.refunded_minor).toBe(2); // the two 1-cent refunds above
    expect(main.remaining_minor).toBe(448);
    expect(main.titles.length).toBeGreaterThan(0);
    expect(withMfa!.refunds!.enabled).toBe(true);
  });
});

/** A request left open by a path that never sent it (a case offer): state requested, no refund id. */
async function openRequest(unit: BoughtUnit, minor: number): Promise<string> {
  const cap = await w.app.db.query<{ capture_id: string }>(
    'SELECT capture_id FROM order_units WHERE id = $1',
    [unit.unit_id],
  );
  const id = `rfr_state_${minor}_${unit.unit_id.slice(-8)}`;
  await w.app.db.query(
    `INSERT INTO refund_requests (id, unit_id, capture_id, amount_minor, currency, reason, requested_by, state, refund_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'left open by a case offer', 'operator:opr_vikram', 'requested', NULL, now(), now())`,
    [id, unit.unit_id, cap.rows[0]!.capture_id, minor, unit.currency],
  );
  return id;
}
