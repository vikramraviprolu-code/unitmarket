// State tests of startup recovery (lane 05b): sent and prepared operations become unknown, the
// first thing after a restart is a read, and a reopened capture is left alone.
import { afterEach, describe, expect, it } from 'vitest';
import { beginCheckout, executeRefund, recoverOnStartup, requestRefund, runDue } from './index';
import {
  BUYER_A,
  alertKinds,
  approved,
  count,
  OPERATOR,
  deadCapture,
  makeWorld,
  paid,
  opOf,
  ops,
  orderStatus,
  place,
  sentCapture,
} from './ops/support';
import type { OpsWorld } from './ops/support';
import { onBuyerReturn } from './index';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

describe('recoverOnStartup', () => {
  it('a sent capture becomes unknown with next_retry_at now, is read first and ends terminal', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('sent');
    expect(await orderStatus(w, a.order_id)).toBe('capture_requested');
    const callsBefore = w.paypal.calls.length;
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(1);
    const after = w.paypal.calls.slice(callsBefore).map((c) => c.op);
    expect(after[0]).toBe('get'); // read first
    expect(after).not.toContain('capture'); // the capture had happened: never sent again
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('confirmed');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
  it('the operation is unknown with next_retry_at = now while the outbound switch is off', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    w.switches.paypal_outbound = false;
    w.tick(5000);
    const callsBefore = w.paypal.calls.length;
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(1);
    expect(w.paypal.calls.length).toBe(callsBefore);
    const op = await opOf(w, a.order_id, 'capture');
    expect(op.state).toBe('unknown');
    expect(op.next_retry_at!.toISOString()).toBe(w.clock.now().toISOString());
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    // The switch comes back: the work is picked up.
    w.switches.paypal_outbound = true;
    const again = await recoverOnStartup(w.restart());
    expect(again.resumed).toBe(0);
  });
  it('a dead capture (never reached PayPal) is read, then sent once more with the same key', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    await recoverOnStartup(w.restart());
    const captures = w.paypal.calls.filter((c) => c.op === 'capture');
    expect(captures).toHaveLength(2);
    expect(captures[1]!.request_id).toBe(captures[0]!.request_id);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('a restart long after the 5 h limit reads but never captures', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.tick(6 * 3_600_000);
    await recoverOnStartup(w.restart());
    expect(w.paypal.count('capture')).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
  });
  it('a sent create becomes unknown and is resent with its own key: one PayPal order', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.beforeCreate = () => Promise.reject(new Error('process died during the create'));
    await expect(beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A })).rejects.toThrow();
    w.paypal.beforeCreate = null;
    expect((await opOf(w, p.order_id, 'create')).state).toBe('sent');
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(1);
    expect(await orderStatus(w, p.order_id)).toBe('awaiting_buyer');
    expect(w.paypal.orders.size).toBe(1);
    const creates = w.paypal.calls.filter((c) => c.op === 'create');
    expect(creates[1]!.request_id).toBe(creates[0]!.request_id);
  });
  it('a create that PayPal did see (answer lost) is not created twice', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.faults.loseCreateResponse = true;
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    w.faults.loseCreateResponse = false;
    expect(c.ok).toBe(false);
    expect(w.paypal.orders.size).toBe(1);
    w.tick(31_000); // the answer was lost with the process alive: the operation is already unknown
    await recoverOnStartup(w.restart());
    expect(await orderStatus(w, p.order_id)).toBe('awaiting_buyer');
    expect(w.paypal.orders.size).toBe(1);
  });
  it('a prepared create of an order that is still created is resumed', async () => {
    w = await makeWorld();
    const p = await place(w);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('prepared');
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(1);
    expect(await orderStatus(w, p.order_id)).toBe('awaiting_buyer');
    expect(w.paypal.orders.size).toBe(1);
  });
  it('a capture reopened for the buyer (prepared, order awaiting) is left alone', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=again',
      debug_id: null,
    });
    const r0 = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    expect(r0.ok).toBe(true);
    expect((await ops(w, a.order_id)).find((o) => o.kind === 'capture')!.state).toBe('prepared');
    const callsBefore = w.paypal.calls.length;
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(0);
    expect(w.paypal.calls.length).toBe(callsBefore);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });
  it('nothing to recover: resumed 0, no call', async () => {
    w = await makeWorld();
    expect((await recoverOnStartup(w.restart())).resumed).toBe(0);
    expect(w.paypal.calls).toHaveLength(0);
  });
  it('a restart twice: the second one resumes nothing and sends nothing', async () => {
    w = await makeWorld();
    await sentCapture(w);
    await recoverOnStartup(w.restart());
    const before = w.paypal.calls.length;
    expect((await recoverOnStartup(w.restart())).resumed).toBe(0);
    expect(w.paypal.calls.length).toBe(before);
    expect(
      await alertKinds(w, (await w.rows<{ id: string }>('SELECT id FROM orders'))[0]!.id),
    ).toEqual([]);
  });

  it('a refund call that died with the process: unknown after the restart, sent again with its key inside 5 h', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!;
    const rq = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'x',
      actor: OPERATOR,
    });
    if (!rq.ok) throw new Error('refused');
    const real = w.paypal.refundCapture.bind(w.paypal);
    w.paypal.refundCapture = () => Promise.reject(new Error('process died'));
    await expect(
      executeRefund(w.deps, { refund_request_id: rq.value.refund_request_id }),
    ).rejects.toThrow();
    w.paypal.refundCapture = real;
    const state = async () =>
      (await w.rows<{ state: string }>('SELECT state FROM refund_requests'))[0]!.state;
    expect(await state()).toBe('sent');
    w.tick(61_000);
    w.switches.paypal_outbound = false;
    expect((await recoverOnStartup(w.restart())).resumed).toBe(1);
    expect(await state()).toBe('unknown');
    w.switches.paypal_outbound = true;
    await runDue(w.deps, { max_items: 10 });
    expect(await state()).toBe('completed');
    expect(w.refundCalls.at(-1)!.request_id).toBe(`umsR-${rq.value.refund_request_id}`);
    expect(await count(w, 'ledger_entries', "kind = 'refund'")).toBe(1);
  });
  it('a refund call that died, found after 5 h: never sent again, the operation ends and is counted', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!;
    const rq = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!rq.ok) throw new Error('refused');
    w.paypal.refundCapture = () => Promise.reject(new Error('process died'));
    await expect(
      executeRefund(w.deps, { refund_request_id: rq.value.refund_request_id }),
    ).rejects.toThrow();
    w.tick(5 * 3_600_000 + 1000);
    w.switches.paypal_outbound = false;
    await recoverOnStartup(w.restart());
    w.switches.paypal_outbound = true;
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.expired).toBe(1);
    const op = (
      await w.rows<{ state: string; failure_reason: string }>(
        "SELECT state, failure_reason FROM operations WHERE kind = 'refund'",
      )
    )[0]!;
    expect([op.state, op.failure_reason]).toEqual(['failed', 'window_expired']);
    expect(await count(w, 'ledger_entries', "kind = 'refund'")).toBe(0);
  });
});
