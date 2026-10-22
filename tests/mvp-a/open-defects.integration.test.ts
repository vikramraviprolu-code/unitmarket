// OPEN DEFECTS found by the Opus second-pass review of domain/payments (main 7345ad4). The owning
// lane (FIX-PAY2, branch fix/payments-pass2) is fixing both. These tests state the required
// behaviour from the requirements ("an accepted capture or refund is always read back; the order
// never stays in flight with nothing polling it") and are expected to FAIL on main today, so they
// are describe.skip until FIX-PAY2 merges. After the merge: change describe.skip to describe, run
// them, and they must pass. They go through public entry points only; no production file is touched.
//   OD-1 (HIGH)  capture_claimed stuck: the process dies between the capture claim and the
//                post-capture read; no read-back operation exists, nothing polls, order never settles.
//   OD-2 (HIGH)  refund accepted at PayPal but the read-back fails once; the refund request stays
//                pending forever, the sale is never reversed, access never ends.
import { executeRefund, onBuyerReturn, requestRefund, runDue } from '@umsbx/payments';
import { describe, expect, it } from 'vitest';
import type { Money, RefundRes } from '@umsbx/contracts';
import { BUYER_A, HOUR, one, placeAndCheckout, rows, makeWorld } from './world';
import type { World } from './world';

const OPERATOR = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;

async function pump(w: World, hours: number): Promise<void> {
  for (let k = 0; k < hours; k += 1) {
    w.td.clock.advance(HOUR);
    await runDue(w.deps, { max_items: 10 });
  }
}

describe.skip('OPEN DEFECT OD-1 (HIGH, FIX-PAY2 H-1): capture claim without a read-back operation', () => {
  it('the process dies between the claim and the post-capture read; the poll still finishes the order', async () => {
    const w = await makeWorld();
    const order = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    w.paypal.approve(order.order_ref);
    const realGet = w.paypal.getOrder.bind(w.paypal);
    let gets = 0;
    w.paypal.getOrder = async (id) => {
      gets += 1;
      if (gets === 2) throw new Error('process died before the read-back');
      return realGet(id);
    };
    await onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: BUYER_A }).catch(
      () => undefined,
    );
    w.paypal.getOrder = realGet;
    expect(w.paypal.count('capture')).toBe(1);
    await pump(w, 2);
    expect(await one<{ status: string }>(w, 'SELECT status FROM orders LIMIT 1')).toEqual({
      status: 'paid',
    });
    expect(await rows(w, 'SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'captured', access_state: 'available' },
    ]);
    expect(w.paypal.count('capture')).toBe(1);
  });
});

describe.skip('OPEN DEFECT OD-2 (HIGH, FIX-PAY2 H-2): refund accepted but never read back', () => {
  it('getRefund fails once after PayPal accepted the refund; a later poll books it', async () => {
    const w = await makeWorld();
    const order = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    w.paypal.approve(order.order_ref);
    await onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: BUYER_A });
    const unit = await one<{ id: string; amount_minor: number }>(
      w,
      'SELECT id, amount_minor FROM order_units LIMIT 1',
    );
    await w.td.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'refunds_enabled'`);
    const amount: Money = { currency: 'USD', minor: unit.amount_minor };
    const accepted: RefundRes = {
      kind: 'refund',
      refund_id: 'SBXGATEREF00001',
      status: 'COMPLETED',
      amount,
      capture_id: null,
      debug_id: 'DBGREF',
    };
    let reads = 0;
    Object.assign(w.paypal, {
      refundCapture: async () => accepted,
      getRefund: async () => {
        reads += 1;
        if (reads === 1) throw new Error('socket hang up');
        return accepted;
      },
    });
    const req = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'gate',
      actor: OPERATOR,
    });
    if (!req.ok) throw new Error(`request: ${req.error.code}`);
    await executeRefund(w.deps, { refund_request_id: req.value.refund_request_id }).catch(
      () => undefined,
    );
    await pump(w, 2);
    expect(await rows(w, 'SELECT state FROM refund_requests')).toEqual([{ state: 'completed' }]);
    expect(
      await rows(w, "SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'"),
    ).toHaveLength(1);
    expect(await rows(w, 'SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'refunded', access_state: 'ended' },
    ]);
  });
});
