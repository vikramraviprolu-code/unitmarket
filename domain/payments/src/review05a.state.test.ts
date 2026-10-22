// FIX-05A: tests for the Opus review of lane 05a (H1, H2, H3, M2, M3, M4, LOW) and the five alert
// kinds of lane 05b. Each test encodes a failure scenario from the review probes (A to E) against a
// real PGlite database and a scripted PayPal that, like PayPal, replays the stored answer for a
// PayPal-Request-Id within 6 hours. Money-critical: none of these may be weakened.
import { afterEach, describe, expect, it } from 'vitest';
import { applyReadback, onBuyerReturn, placeOrder, raiseAlert, readApplyGates } from './index';
import {
  BUYER_A,
  RETENTION_MS,
  approved,
  awaiting,
  count,
  makeWorld,
  place,
  reapply,
} from './support';
import type { World } from './support';
import type { CaptureRes, SqlExecutor } from '@umsbx/contracts';

let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const ret = (ref: string) => onBuyerReturn(w.deps, { order_ref: ref, actor: BUYER_A });
const order = async (id: string) =>
  (
    await w.rows<{ status: string; mismatch: boolean }>(
      'SELECT status, mismatch FROM orders WHERE id = $1',
      [id],
    )
  )[0]!;
const units = (order_id: string) =>
  w.rows<Record<string, unknown>>('SELECT * FROM order_units WHERE order_id = $1 ORDER BY id', [
    order_id,
  ]);
const ents = () => w.rows<Record<string, unknown>>('SELECT * FROM entitlements ORDER BY id');
const cop = async (order_id: string, kind = 'capture') =>
  (
    await w.rows<Record<string, unknown>>(
      'SELECT * FROM operations WHERE order_id = $1 AND kind = $2',
      [order_id, kind],
    )
  )[0]!;
const alertKinds = async () =>
  (await w.rows<{ kind: string }>('SELECT kind FROM alerts ORDER BY kind, id')).map((r) => r.kind);
const until = async (f: () => boolean): Promise<void> => {
  for (let k = 0; k < 400 && !f(); k += 1) await new Promise<void>((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};
const holdCapture = (): (() => void) => {
  let release: () => void = () => undefined;
  w.paypal.hold = new Promise<void>((r) => {
    release = () => {
      w.paypal.hold = null;
      r();
    };
  });
  return release;
};
const payerAction: CaptureRes = { kind: 'payer_action', redirect_url: null, debug_id: 'D' };
const reject = (issue: string, http: 400 | 422 = 422): CaptureRes => ({
  kind: 'rejected',
  http,
  name: http === 400 ? 'INVALID_REQUEST' : 'UNPROCESSABLE_ENTITY',
  issue,
  debug_id: 'D',
});

// ---------------------------------------------------------------------------------------------
describe('H1 probe A: a held capture while a concurrent read freezes the order', () => {
  // The capture call is held; a concurrent read shows amount +1 and freezes the order (the unit is
  // `mismatch`). The capture then answers. Whatever it answers, the order stays frozen: it never
  // goes back to awaiting_buyer, never to unresolved or capture_claimed, and a second return
  // neither reads nor captures. The buyer is never told "You were not charged".
  const answers: [string, CaptureRes | null][] = [
    ['payer_action', payerAction],
    ['ORDER_NOT_APPROVED', reject('ORDER_NOT_APPROVED')],
    ['timeout', { kind: 'timeout' }],
    ['a real claim', null],
  ];
  it.each(answers)('answer %s: frozen stays frozen', async (_name, forced) => {
    w = await makeWorld();
    const a = await approved(w);
    const release = holdCapture();
    const first = ret(a.order_ref);
    await until(() => w.paypal.count('capture') === 1);

    w.paypal.tamper = { amount_delta: 1 };
    const rep = await reapply(w, a.order_id);
    w.paypal.tamper = {};
    expect(rep.order_status).toBe('frozen');
    expect((await units(a.order_id))[0]).toMatchObject({ status: 'mismatch' });
    const alertsBefore = await count(w, 'alerts');
    expect(alertsBefore).toBeGreaterThan(0);

    if (forced !== null) w.paypal.queue.capture.push(forced);
    release();
    const r = await first;
    expect((await order(a.order_id)).status).toBe('frozen');
    expect(r.ok ? r.value.status : 'frozen').toBe('frozen');
    if (r.ok) expect(r.value.buyer_message).not.toMatch(/not charged|not completed/i);

    // The buyer returns again: refused, no new read, no new capture.
    const gets = w.paypal.count('get');
    const again = await ret(a.order_ref);
    expect(again).toEqual({ ok: false, error: { code: 'frozen' } });
    expect(w.paypal.count('capture')).toBe(1);
    expect(w.paypal.count('get')).toBe(gets);
    expect((await order(a.order_id)).status).toBe('frozen');
    expect((await ents())[0]).toMatchObject({ access_state: 'locked' });
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('a clean read after a real claim on a frozen order does not turn it failed or paid', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const release = holdCapture();
    const first = ret(a.order_ref);
    await until(() => w.paypal.count('capture') === 1);
    w.paypal.tamper = { amount_delta: 1 };
    await reapply(w, a.order_id);
    w.paypal.tamper = {};
    release();
    await first;
    // PayPal really captured (the fake did); a clean read arrives later.
    expect(w.paypal.orders.get(a.provider_order_id)!.capture).not.toBeNull();
    const before = await count(w, 'alerts');
    const rep = await reapply(w, a.order_id);
    expect(rep.order_status).toBe('frozen');
    expect(rep.unlocked).toEqual([]);
    expect(await count(w, 'alerts')).toBe(before);
    expect((await order(a.order_id)).status).toBe('frozen');
  });

  it('a unit in mismatch never makes the order failed: it is frozen with an alert', async () => {
    w = await makeWorld();
    const a = await approved(w);
    // The state the review reached: unit mismatch, order unresolved, then a clean read.
    await w.rows(
      "UPDATE order_units SET status = 'mismatch', mismatch_reason = 'amount' WHERE order_id = $1",
      [a.order_id],
    );
    await w.rows("UPDATE orders SET status = 'unresolved' WHERE id = $1", [a.order_id]);
    const rep = await reapply(w, a.order_id);
    expect(rep.order_status).toBe('frozen');
    expect((await order(a.order_id)).status).toBe('frozen');
    expect((await order(a.order_id)).mismatch).toBe(true);
    expect(await alertKinds()).toContain('frozen_order');
  });

  it('a return is refused when the order is flagged mismatch or a unit is in mismatch', async () => {
    for (const sql of [
      'UPDATE orders SET mismatch = true WHERE id = $1',
      "UPDATE order_units SET status = 'mismatch', mismatch_reason = 'amount' WHERE order_id = $1",
    ]) {
      w = await makeWorld();
      const a = await approved(w);
      await w.rows(sql, [a.order_id]);
      const r = await ret(a.order_ref);
      expect(r).toEqual({ ok: false, error: { code: 'frozen' } });
      expect(w.paypal.count('capture')).toBe(0);
      expect((await order(a.order_id)).status).toBe('frozen');
      await w.close();
    }
    w = await makeWorld();
  });

  it('DUPLICATE_INVOICE_ID on a capture that raced with a freeze keeps the order frozen and alerts', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const release = holdCapture();
    const first = ret(a.order_ref);
    await until(() => w.paypal.count('capture') === 1);
    w.paypal.tamper = { amount_delta: 1 };
    await reapply(w, a.order_id);
    w.paypal.tamper = {};
    w.paypal.queue.capture.push(reject('DUPLICATE_INVOICE_ID'));
    release();
    await first;
    expect((await order(a.order_id)).status).toBe('frozen');
    expect(await alertKinds()).toContain('frozen_order');
  });
});

// ---------------------------------------------------------------------------------------------
describe('M2 probe C: a paid order never regresses', () => {
  it('a poll verifies and unlocks while the capture call is held; the late timeout changes nothing', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const release = holdCapture();
    const first = ret(a.order_ref);
    await until(() => w.paypal.count('capture') === 1);
    // PayPal captured; the poller sees it and books it.
    w.paypal.orders.get(a.provider_order_id)!.capture = {
      capture_id: 'SBXFAKECAP90001',
      status: 'COMPLETED',
      reason: null,
      fee: 45,
    };
    w.paypal.orders.get(a.provider_order_id)!.status = 'COMPLETED';
    const rep = await reapply(w, a.order_id);
    expect(rep.order_status).toBe('paid');
    expect(rep.unlocked).toHaveLength(1);
    w.paypal.queue.capture.push({ kind: 'timeout' });
    release();
    const r = await first;
    expect(r.ok && r.value.status).toBe('paid');
    expect((await order(a.order_id)).status).toBe('paid');
    expect((await cop(a.order_id)).state).not.toBe('unknown');
    expect((await ents())[0]).toMatchObject({ money_state: 'captured', access_state: 'available' });
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('H2 probe B: a capture key is not resent after payer_action; a new try is capped', () => {
  it('T+6h: the same key is not resent; a read comes first and a NEW key umsK-<ref>-2 captures', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(payerAction);
    const r1 = await ret(a.order_ref);
    expect(r1.ok && r1.value.status).toBe('awaiting_buyer');
    expect((await cop(a.order_id)).attempt).toBe(1);

    w.clock.advance(RETENTION_MS + 3_600_000); // T+7h: past the 5 h window and PayPal's 6 h retention
    const r2 = await ret(a.order_ref);
    expect(r2.ok && r2.value.status).toBe('paid');

    const caps = w.paypal.calls.filter((c) => c.op === 'capture');
    expect(caps.map((c) => c.request_id)).toEqual([`umsK-${a.order_ref}`, `umsK-${a.order_ref}-2`]);
    // A read of the order precedes the second capture (read-back shows no capture first).
    const seq = w.paypal.calls.map((c) => c.op);
    const second = seq.lastIndexOf('capture');
    expect(seq[second - 1]).toBe('get');
    const op = await cop(a.order_id);
    expect(op.attempt).toBe(2);
    expect(op.request_id).toBe(`umsK-${a.order_ref}-2`);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });

  it('inside 5 h the second try also uses a new key and counts as attempt 2', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(payerAction);
    await ret(a.order_ref);
    w.clock.advance(60_000);
    const r2 = await ret(a.order_ref);
    expect(r2.ok && r2.value.status).toBe('paid');
    expect(w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}`,
      `umsK-${a.order_ref}-2`,
    ]);
  });

  it('the cap is 1 + max_capture_retries: a third try sends nothing and raises one alert', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(payerAction, payerAction);
    await ret(a.order_ref);
    await ret(a.order_ref);
    expect(w.paypal.count('capture')).toBe(2);
    w.clock.advance(60_000);
    const third = await ret(a.order_ref);
    expect(third.ok).toBe(false);
    expect(w.paypal.count('capture')).toBe(2);
    expect((await order(a.order_id)).status).toBe('awaiting_buyer');
    expect((await cop(a.order_id)).attempt).toBe(2);
    expect(await alertKinds()).toEqual(['payment_unresolved']);
    // The same return again raises nothing new and still sends nothing.
    await ret(a.order_ref);
    expect(w.paypal.count('capture')).toBe(2);
    expect(await alertKinds()).toEqual(['payment_unresolved']);
  });

  it('ORDER_NOT_APPROVED counts as an attempt too', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(reject('ORDER_NOT_APPROVED'), reject('ORDER_NOT_APPROVED'));
    await ret(a.order_ref);
    await ret(a.order_ref);
    await ret(a.order_ref);
    expect(w.paypal.count('capture')).toBe(2);
  });

  it('the fake replays the stored answer for a key within 6 h and treats it as new after', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const req = { provider_order_id: a.provider_order_id, request_id: 'k-1', scenario: null };
    w.paypal.orders.get(a.provider_order_id)!.status = 'CREATED';
    const first = await w.paypal.captureOrder(req);
    expect(first).toMatchObject({ kind: 'rejected', issue: 'ORDER_NOT_APPROVED' });
    w.paypal.approve(a.provider_order_id);
    // The buyer approved in between; the same key still gets the old answer.
    expect(await w.paypal.captureOrder(req)).toEqual(first);
    w.clock.advance(RETENTION_MS + 1);
    expect(await w.paypal.captureOrder(req)).toMatchObject({ kind: 'claim' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('M3: the error table', () => {
  it('capture 400 invalid_request: one alert, no retry, the read decides', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(reject('INVALID_REQUEST', 400));
    await ret(a.order_ref);
    expect(await alertKinds()).toContain('payment_unresolved');
    expect((await cop(a.order_id)).failure_reason).toBe('invalid_request');
    w.clock.advance(60_000);
    await ret(a.order_ref);
    expect(w.paypal.count('capture')).toBe(1);
  });

  it('create DUPLICATE_INVOICE_ID: the order is frozen with an alert, nothing is declined', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    const { beginCheckout } = await import('./index');
    const r = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(r.ok).toBe(false);
    expect((await order(p.order_id)).status).toBe('frozen');
    expect((await order(p.order_id)).mismatch).toBe(true);
    expect(await alertKinds()).toEqual(['frozen_order']);
    expect((await units(p.order_id))[0]).toMatchObject({ status: 'expected' });
    expect((await ents())[0]).toMatchObject({ money_state: 'pending' });
    expect(w.paypal.count('create')).toBe(1);
  });

  it('capture blocked by the kill switch answers payments_paused and leaves the order awaiting the buyer', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({ kind: 'blocked', by: 'budget' });
    const r = await ret(a.order_ref);
    expect(r).toEqual({ ok: false, error: { code: 'payments_paused' } });
    expect((await order(a.order_id)).status).toBe('awaiting_buyer');
    const op = await cop(a.order_id);
    expect(op.state).toBe('prepared');
    expect(op.attempt).toBe(1);
    expect(op.request_id).toBe(`umsK-${a.order_ref}`);
    // Switched back on: the first try is still the first try.
    const again = await ret(a.order_ref);
    expect(again.ok && again.value.status).toBe('paid');
    expect(w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}`,
      `umsK-${a.order_ref}`,
    ]);
  });

  it('blocked on the second try restores the first try state (no attempt is spent)', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(payerAction, { kind: 'blocked', by: 'budget' });
    await ret(a.order_ref);
    const blocked = await ret(a.order_ref);
    expect(blocked).toEqual({ ok: false, error: { code: 'payments_paused' } });
    const op = await cop(a.order_id);
    expect(op.attempt).toBe(1);
    expect(op.request_id).toBe(`umsK-${a.order_ref}`);
    const third = await ret(a.order_ref);
    expect(third.ok && third.value.status).toBe('paid');
    expect(w.paypal.calls.filter((c) => c.op === 'capture').at(-1)!.request_id).toBe(
      `umsK-${a.order_ref}-2`,
    );
  });

  it.each([
    ['TRANSACTION_REFUSED', 422 as const],
    ['COMPLIANCE_VIOLATION', 422 as const],
    ['INVALID_REQUEST', 400 as const],
  ])(
    'a definitive refusal (%s) with no capture on the read closes the order as failed, not charged',
    async (issue, http) => {
      w = await makeWorld();
      const a = await approved(w);
      w.paypal.queue.capture.push(reject(issue, http));
      const r = await ret(a.order_ref);
      expect(r.ok && r.value.status).toBe('failed');
      expect(r.ok && r.value.buyer_message).toMatch(/not charged/i);
      expect((await units(a.order_id))[0]).toMatchObject({ status: 'declined' });
      expect((await ents())[0]).toMatchObject({ money_state: 'denied', access_state: 'locked' });
      expect(await count(w, 'ledger_entries')).toBe(0);
      expect(w.paypal.count('capture')).toBe(1);
      // A further return neither reads nor captures.
      const again = await ret(a.order_ref);
      expect(again.ok && again.value.status).toBe('failed');
      expect(w.paypal.count('capture')).toBe(1);
    },
  );

  it('a definitive refusal where the read DOES show a capture is not closed as failed', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(reject('TRANSACTION_REFUSED'));
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 2) {
        w.paypal.orders.get(a.provider_order_id)!.capture = {
          capture_id: 'SBXFAKECAP90002',
          status: 'COMPLETED',
          reason: null,
          fee: 45,
        };
        w.paypal.orders.get(a.provider_order_id)!.status = 'COMPLETED';
      }
      return Promise.resolve();
    };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------------------------
describe('H3 probes D and E: no second charge for an article already held or in flight', () => {
  const placeWith = async (o: Parameters<typeof place>[1] = {}) => {
    const approval = await w.approval(o);
    return placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
  };

  it('probe D: unlock off, order paid, access locked: the same option again is refused', async () => {
    w = await makeWorld();
    w.switches.unlock_enabled = false;
    const a = await approved(w);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    expect((await ents())[0]).toMatchObject({ money_state: 'captured', access_state: 'locked' });
    const again = await placeWith();
    expect(again).toEqual({ ok: false, error: { code: 'already_owned', http: 409 } });
    const other = await placeWith({ option: 'online_read' });
    expect(other).toEqual({ ok: false, error: { code: 'already_owned', http: 409 } });
    expect(await count(w, 'orders')).toBe(1);
  });

  it('probe E: while the first order is in flight, another option of the same article is refused', async () => {
    w = await makeWorld();
    await place(w);
    const other = await placeWith({ option: 'online_read' });
    expect(other).toEqual({ ok: false, error: { code: 'already_owned', http: 409 } });
    expect(await count(w, 'orders')).toBe(1);
    // The refused approval was not consumed.
    expect(await count(w, 'approvals', 'used_at IS NOT NULL')).toBe(1);
  });

  it('an approval with several articles is refused when any one is held', async () => {
    w = await makeWorld();
    await place(w, { offers: ['ofr_3'] });
    const r = await placeWith({ offers: ['ofr_1', 'ofr_3'] });
    expect(r).toEqual({ ok: false, error: { code: 'already_owned', http: 409 } });
  });

  it('another buyer may buy the same article', async () => {
    w = await makeWorld();
    await place(w);
    const approval = await w.approval({ buyer_id: 'buy_B' });
    const r = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: { kind: 'buyer', buyer_id: 'buy_B' },
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['money denied', "money_state = 'denied', licence_state = NULL"],
    ['access ended', "access_state = 'ended'"],
    ['access revoked', "access_state = 'revoked'"],
  ])('%s: the article may be bought again', async (_n, set) => {
    w = await makeWorld();
    const first = await approved(w);
    const r = await ret(first.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    // A closed order of the same content does not block either (paid is closed).
    await w.rows(`UPDATE entitlements SET ${set}`);
    const second = await placeWith();
    expect(second.ok).toBe(true);
  });

  it('the database refuses two active entitlements of one buyer and article', async () => {
    w = await makeWorld();
    await place(w, { offers: ['ofr_1'] });
    const other = await place(w, { offers: ['ofr_3'] });
    await expect(
      w.rows(
        'UPDATE entitlements SET article_id = $1 WHERE unit_id IN (SELECT id FROM order_units WHERE order_id = $2)',
        ['art_1', other.order_id],
      ),
    ).rejects.toThrow(/entitlements_one_active_per_buyer_article|duplicate key/);
  });

  it('the database allows a second entitlement when the first is denied', async () => {
    w = await makeWorld();
    await place(w, { offers: ['ofr_1'] });
    const other = await place(w, { offers: ['ofr_3'] });
    await w.rows("UPDATE entitlements SET money_state = 'denied' WHERE article_id = 'art_1'");
    await w.rows(
      'UPDATE entitlements SET article_id = $1 WHERE unit_id IN (SELECT id FROM order_units WHERE order_id = $2)',
      ['art_1', other.order_id],
    );
    expect(await count(w, 'entitlements', "article_id = 'art_1'")).toBe(2);
  });

  it('LOW: a payee whose merchant id changed or was unverified since the approval is refused', async () => {
    for (const set of ["paypal_merchant_id = 'OTHER'", 'payee_verified_at = NULL']) {
      w = await makeWorld();
      const approval = await w.approval();
      await w.rows(`UPDATE publishers SET ${set} WHERE id = 'pub_1'`);
      const r = await placeOrder(w.deps, {
        approval_id: approval.approval_id,
        token: approval.token,
        actor: BUYER_A,
      });
      expect(r).toEqual({ ok: false, error: { code: 'payee_unavailable', http: 409 } });
      expect(await count(w, 'orders')).toBe(0);
      expect(await count(w, 'approvals', 'used_at IS NOT NULL')).toBe(0);
      await w.close();
    }
    w = await makeWorld();
  });
});

// ---------------------------------------------------------------------------------------------
describe('M4 and LOW: applyReadback money paths', () => {
  it('a lost unit compare-and-set books nothing and starts nothing (and does not throw)', async () => {
    w = await makeWorld();
    const a = await approved(w);
    // Capture happened at PayPal, answer lost: the order waits for a read.
    w.paypal.next = { ...w.paypal.next, lose_response: true };
    await ret(a.order_ref);
    expect((await order(a.order_id)).status).toBe('unresolved');
    const read = await w.paypal.getOrder(a.provider_order_id);
    if (read.kind !== 'order') throw new Error('read failed');
    const gates = await readApplyGates(w.deps, a.order_id);
    const report = await w.db.transaction((tx) => {
      // Another transaction wins the verification: this one's compare-and-set matches no row.
      const racing = new Proxy(tx, {
        get(target, prop) {
          if (prop === 'query') {
            return (sql: string, params?: unknown[]) =>
              sql.includes("SET status = 'captured_verified'")
                ? Promise.resolve({ rows: [], rowCount: 0 })
                : target.query(sql, params);
          }
          const v: unknown = Reflect.get(target, prop);
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      }) as SqlExecutor;
      return applyReadback(racing, w.deps, {
        order_id: a.order_id,
        read,
        trigger: 'poll',
        gates,
      });
    });
    expect(report.unlocked).toEqual([]);
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect((await ents())[0]).toMatchObject({ money_state: 'pending', access_state: 'locked' });
    expect(await count(w, 'access_events')).toBe(0);
    expect((await units(a.order_id))[0]).toMatchObject({ status: 'expected' });
  });

  it('a read taken before the claim is stored writes nothing to the unit (no pending)', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.next = { ...w.paypal.next, lose_response: true };
    await ret(a.order_ref);
    const cap = w.paypal.orders.get(a.provider_order_id)!.capture!;
    w.clock.advance(60_000);
    await w.rows('UPDATE order_units SET capture_id = $2, updated_at = $3 WHERE order_id = $1', [
      a.order_id,
      cap.capture_id,
      w.clock.now().toISOString(),
    ]);
    const read = await w.paypal.getOrder(a.provider_order_id);
    if (read.kind !== 'order') throw new Error('read failed');
    const stale = { ...read, read_at: new Date(w.clock.now().getTime() - 30_000).toISOString() };
    const report = await w.db.transaction((tx) =>
      applyReadback(tx, w.deps, { order_id: a.order_id, read: stale, trigger: 'poll' }),
    );
    expect(report.pending).toHaveLength(1);
    expect(report.unlocked).toEqual([]);
    const u = (await units(a.order_id))[0]!;
    expect(u.status).toBe('expected');
    expect(u.status_reason).toBeNull();
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('a frozen order with a clean read raises no new alert and unlocks nothing', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.tamper = { amount_delta: 1 };
    await ret(a.order_ref);
    w.paypal.tamper = {};
    expect((await order(a.order_id)).status).toBe('frozen');
    // Money is at PayPal for this order (a human froze it); a clean read must not act.
    w.paypal.orders.get(a.provider_order_id)!.capture = {
      capture_id: 'SBXFAKECAP90003',
      status: 'COMPLETED',
      reason: null,
      fee: 45,
    };
    w.paypal.orders.get(a.provider_order_id)!.status = 'COMPLETED';
    const before = await count(w, 'alerts');
    const rep = await reapply(w, a.order_id);
    expect(rep.alerts).toEqual([]);
    expect(rep.unlocked).toEqual([]);
    expect(rep.order_status).toBe('frozen');
    expect(await count(w, 'alerts')).toBe(before);
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('LOW: a unit declined on an early read whose capture later shows COMPLETED alerts a human', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.next = { ...w.paypal.next, status: 'DECLINED', fee: null };
    await ret(a.order_ref);
    expect((await units(a.order_id))[0]).toMatchObject({ status: 'declined' });
    // The order is failed; a later read shows the capture as COMPLETED (should not happen).
    w.paypal.orders.get(a.provider_order_id)!.capture!.status = 'COMPLETED';
    const rep = await reapply(w, a.order_id);
    expect(rep.unlocked).toEqual([]);
    expect(await alertKinds()).toContain('unexpected_capture');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('LOW: concurrent returns share one pre-capture read', () => {
  it('20 concurrent returns cost far fewer than 20 reads and one capture', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const release = holdCapture();
    const all = Array.from({ length: 20 }, () => ret(a.order_ref));
    await until(() => w.paypal.count('capture') === 1);
    await new Promise<void>((r) => setTimeout(r, 100));
    release();
    const results = await Promise.all(all);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(w.paypal.count('capture')).toBe(1);
    // One pre-capture read, one read-back; nobody else reads.
    expect(w.paypal.count('get')).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------
describe('alert kinds of lane 05b are part of AlertKind (no cast)', () => {
  it.each([
    'payment_unresolved',
    'reversal',
    'refund_unbooked',
    'refund_failed',
    'refund_unresolved',
  ] as const)('%s', async (kind) => {
    w = await makeWorld();
    const a = await awaiting(w);
    const raised = await w.db.transaction((tx) =>
      raiseAlert(tx, w.deps, { kind, order_id: a.order_id, unit_id: null, reason: 'x' }),
    );
    expect(raised).toBe(kind);
    expect(await alertKinds()).toEqual([kind]);
  });
});
