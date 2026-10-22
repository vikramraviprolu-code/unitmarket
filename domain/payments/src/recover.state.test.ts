// State tests of startup recovery (lane 05b): sent and prepared operations become unknown, the
// first thing after a restart is a read, and a reopened capture is left alone.
import { afterEach, describe, expect, it } from 'vitest';
import { beginCheckout, recoverOnStartup } from './index';
import {
  BUYER_A,
  alertKinds,
  approved,
  count,
  deadCapture,
  makeWorld,
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
    expect((await ops(w, a.order_id))[0]!.state).toBe('sent');
    expect(await orderStatus(w, a.order_id)).toBe('capture_requested');
    const callsBefore = w.paypal.calls.length;
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(1);
    const after = w.paypal.calls.slice(callsBefore).map((c) => c.op);
    expect(after[0]).toBe('get'); // read first
    expect(after).not.toContain('capture'); // the capture had happened: never sent again
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect((await ops(w, a.order_id))[0]!.state).toBe('confirmed');
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
    const op = (await ops(w, a.order_id))[0]!;
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
    expect((await ops(w, p.order_id))[0]!.state).toBe('sent');
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
    await recoverOnStartup(w.restart());
    expect(await orderStatus(w, p.order_id)).toBe('awaiting_buyer');
    expect(w.paypal.orders.size).toBe(1);
  });
  it('a prepared create of an order that is still created is resumed', async () => {
    w = await makeWorld();
    const p = await place(w);
    expect((await ops(w, p.order_id))[0]!.state).toBe('prepared');
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
});
