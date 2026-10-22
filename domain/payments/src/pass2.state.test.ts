// FIX-PAY2 regression tests (Opus second-pass review at main 7345ad4). Each describe block is one
// finding and was red on main before the fix: H-1, H-2, M-1, M-2 and the LOW items. The probes are
// the reviewer's probe6.state.test.ts turned into assertions. Synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkInvariants,
  executeRefund,
  nextDueAt,
  onBuyerReturn,
  recoverOnStartup,
  requestRefund,
  runDue,
} from './index';
import {
  BUYER_A,
  OPERATOR,
  alertKinds,
  approved,
  makeWorld,
  opOf,
  ops,
  orderStatus,
  paid,
  sentCapture,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  await w.close();
});
const H = 3_600_000;

const unitOf = async (order_id: string): Promise<string> =>
  (await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [order_id]))[0]!
    .id;
const invariants = async (): Promise<Record<string, boolean>> =>
  Object.fromEntries((await checkInvariants(w.deps.db)).map((r) => [r.id, r.ok]));
async function pump(hours: number): Promise<void> {
  for (let k = 0; k < hours; k += 1) {
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });
  }
}

describe('H-1: a capture claim always leaves a read-back operation behind', () => {
  async function crashAfterClaim(): Promise<Awaited<ReturnType<typeof approved>>> {
    const a = await approved(w);
    let gets = 0;
    w.paypal.beforeGet = async () => {
      gets += 1;
      if (gets === 2) throw new Error('process died before the read-back');
    };
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A }).catch(() => undefined);
    w.paypal.beforeGet = null;
    return a;
  }

  it('P1: the process dies between the claim and the post-capture read; the poll finishes the order', async () => {
    w = await makeWorld();
    const a = await crashAfterClaim();
    expect(w.paypal.count('capture')).toBe(1);
    // The claim transaction itself stored the read-back operation: something polls.
    expect(await orderStatus(w, a.order_id)).toBe('capture_claimed');
    expect((await opOf(w, a.order_id, 'readback')).state).toBe('unknown');
    expect(await nextDueAt(w.deps.db)).not.toBeNull();
    expect((await invariants())['INV5']).toBe(true);
    await pump(2);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'captured', access_state: 'available' },
    ]);
    expect(w.paypal.count('capture')).toBe(1); // never charged twice
    expect(await alertKinds(w, a.order_id)).toEqual([]);
  });

  it('INV5 flags an order in flight with nothing to poll, and startup recovery repairs it', async () => {
    w = await makeWorld();
    const a = await crashAfterClaim();
    // The state main could leave behind: the read-back operation is not there.
    await w.db.query("DELETE FROM operations WHERE order_id = $1 AND kind = 'readback'", [
      a.order_id,
    ]);
    expect((await invariants())['INV5']).toBe(false);
    await recoverOnStartup(w.restart());
    expect((await invariants())['INV5']).toBe(true);
    await pump(2);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });

  it('INV5 accepts an order handed to a human after the window (failed window_expired)', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    w.paypal.queue.get.push(
      ...Array.from({ length: 80 }, () => ({ kind: 'not_found' as const, debug_id: null })),
    );
    await pump(30);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    expect(
      (await ops(w, a.order_id))
        .filter((o) => o.kind === 'capture' || o.kind === 'readback')
        .every((o) => o.state === 'failed' && o.failure_reason === 'window_expired'),
    ).toBe(true);
    expect((await invariants())['INV5']).toBe(true);
  });
});

describe('H-2: a refund PayPal accepted is always read back', () => {
  it('P3: getRefund throws once after the refund call; a later poll books it', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r1 = await requestRefund(w.deps, {
      unit_id: u,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r1.ok) throw new Error('r1');
    const real = w.deps.paypal.getRefund.bind(w.deps.paypal);
    let n = 0;
    w.deps.paypal.getRefund = async (id) => {
      n += 1;
      if (n === 1) throw new Error('socket hang up');
      return real(id);
    };
    await executeRefund(w.deps, { refund_request_id: r1.value.refund_request_id }).catch(
      () => undefined,
    );
    // Same transaction that stored `pending`: the read-back operation exists and is polled.
    const rb = await w.rows<{ state: string }>(
      'SELECT state FROM operations WHERE request_id = $1',
      [`umsRB-${r1.value.refund_request_id}`],
    );
    expect(rb).toEqual([{ state: 'unknown' }]);
    expect((await invariants())['INV6']).toBe(true);
    await pump(2);
    expect(await w.rows('SELECT state FROM refund_requests')).toEqual([{ state: 'completed' }]);
    expect(
      await w.rows("SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'"),
    ).toHaveLength(1);
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'refunded', access_state: 'revoked' },
    ]);
    expect((await invariants())['INV6']).toBe(true);
  });

  it('INV6 flags an open refund with nothing to poll; recovery repairs it', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r1 = await requestRefund(w.deps, {
      unit_id: u,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r1.ok) throw new Error('r1');
    w.refundNext.status = 'PENDING';
    await executeRefund(w.deps, { refund_request_id: r1.value.refund_request_id });
    await w.db.query("DELETE FROM operations WHERE kind = 'refund_readback'");
    expect((await invariants())['INV6']).toBe(false);
    w.refundNext.status = 'COMPLETED';
    // The refund object at PayPal turns COMPLETED while nothing was looking.
    for (const r of w.refunds.values()) r.status = 'COMPLETED';
    await recoverOnStartup(w.restart());
    expect((await invariants())['INV6']).toBe(true);
    await pump(2);
    expect(await w.rows('SELECT state FROM refund_requests')).toEqual([{ state: 'completed' }]);
  });
});

describe('M-1: operations belong to one refund request', () => {
  it('P2: a second refund has its own operations; the first one is never touched', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r1 = await requestRefund(w.deps, {
      unit_id: u,
      amount: { currency: 'USD', minor: 100 },
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r1.ok) throw new Error('r1');
    await executeRefund(w.deps, { refund_request_id: r1.value.refund_request_id });
    const before = await w.rows(
      'SELECT request_id, state, updated_at FROM operations WHERE request_id LIKE $1 ORDER BY request_id',
      [`%${r1.value.refund_request_id}`],
    );
    w.tick(1000);
    w.refundNext.status = 'PENDING';
    const r2 = await requestRefund(w.deps, {
      unit_id: u,
      amount: { currency: 'USD', minor: 100 },
      reason: 'y',
      actor: OPERATOR,
    });
    if (!r2.ok) throw new Error('r2');
    await executeRefund(w.deps, { refund_request_id: r2.value.refund_request_id });
    const id2 = r2.value.refund_request_id;
    expect(
      await w.rows(
        'SELECT request_id, state FROM operations WHERE request_id LIKE $1 ORDER BY request_id',
        [`%${id2}`],
      ),
    ).toEqual([
      { request_id: `umsR-${id2}`, state: 'confirmed' },
      { request_id: `umsRB-${id2}`, state: 'unknown' },
    ]);
    expect(
      await w.rows(
        'SELECT request_id, state, updated_at FROM operations WHERE request_id LIKE $1 ORDER BY request_id',
        [`%${r1.value.refund_request_id}`],
      ),
    ).toEqual(before);
    // PayPal settles the second refund later.
    for (const r of w.refunds.values()) r.status = 'COMPLETED';
    w.refundNext.status = 'COMPLETED';
    await pump(2);
    expect(await w.rows('SELECT state FROM refund_requests ORDER BY id')).toEqual([
      { state: 'completed' },
      { state: 'completed' },
    ]);
    expect(
      await w.rows("SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'"),
    ).toHaveLength(2);
    expect(
      await w.rows(
        "SELECT 1 FROM operations WHERE kind LIKE 'refund%' AND state IN ('unknown', 'sent')",
      ),
    ).toEqual([]);
    expect((await invariants())['INV6']).toBe(true);
  });

  it('an unknown refund operation does not switch off the 7 day re-read of the paid order', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const verified = (
      await w.rows<{ v: Date }>('SELECT max(captured_verified_at) AS v FROM order_units')
    )[0]!.v;
    const far = new Date(w.clock.now().getTime() + 100 * 24 * H).toISOString();
    await w.db.query(
      `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, reconcile_until, next_retry_at, created_at, updated_at)
       VALUES ('opr_x', $1, NULL, 'refund_readback', 'unknown', 1, 'umsRB-rfr_x', $2, $2, $3, $3)`,
      [a.order_id, far, w.clock.now().toISOString()],
    );
    const next = await nextDueAt(w.deps.db);
    expect(next).toBe(new Date(verified.getTime() + H).toISOString());
  });
});

describe('M-2: a refund is booked from GET refund and the capture status, not from refunded_minor', () => {
  it('P4: refunded_minor reads 0; the full refund is booked and access ends', async () => {
    w = await makeWorld();
    expect(w.reportRefunded).toBe(false);
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r1 = await requestRefund(w.deps, {
      unit_id: u,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r1.ok) throw new Error('r1');
    expect(await executeRefund(w.deps, { refund_request_id: r1.value.refund_request_id })).toEqual({
      ok: true,
      value: { status: 'COMPLETED' },
    });
    await pump(30);
    expect(await w.rows('SELECT state FROM refund_requests')).toEqual([{ state: 'completed' }]);
    expect(
      await w.rows("SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'"),
    ).toHaveLength(1);
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'refunded', access_state: 'revoked' },
    ]);
    expect(await alertKinds(w, a.order_id)).toEqual([]);
    expect((await invariants())['INV1']).toBe(true);
  });

  it('P4: a refund made in the PayPal dashboard (status REFUNDED, amount 0) is detected', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const [cap] = await w.captureIds(a.order_id);
    w.dashboardRefund(cap!, 1500);
    await pump(2);
    expect(await alertKinds(w, a.order_id)).toContain('refund_unbooked');
    expect(await w.rows('SELECT status FROM order_units')).toEqual([{ status: 'refunded' }]);
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'refunded', access_state: 'revoked' },
    ]);
  });

  it('a refund that stays unreadable to the window end is unresolved, not failed, and keeps its reservation', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r1 = await requestRefund(w.deps, {
      unit_id: u,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r1.ok) throw new Error('r1');
    w.refundNext.status = 'PENDING'; // PayPal never settles it in the window
    await executeRefund(w.deps, { refund_request_id: r1.value.refund_request_id });
    await pump(30);
    expect(await w.rows('SELECT state FROM refund_requests')).toEqual([{ state: 'unresolved' }]);
    expect(await alertKinds(w, a.order_id)).toContain('refund_unresolved');
    // The amount stays reserved: an operator cannot send a second refund on top of a possible first.
    const again = await requestRefund(w.deps, {
      unit_id: u,
      amount: null,
      reason: 'z',
      actor: OPERATOR,
    });
    expect(again.ok).toBe(false);
  });
});

describe('LOW: recovery, retry refusals, the capture cap', () => {
  it('startup recovery leaves an operation alone while its lease is running', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(0);
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('sent');
    w.tick(61_000); // the lease (60 s) is over: the process that held it is gone
    const again = await recoverOnStartup(w.restart());
    expect(again.resumed).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });

  it('a 422 refusal of the capture re-send closes the capture as failed, like the first send', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'INSTRUMENT_DECLINED',
      debug_id: 'DBGX',
    });
    w.tick(60_000);
    await runDue(w.deps, { max_items: 10 });
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('failed');
    expect((await opOf(w, a.order_id, 'capture')).failure_reason).toBe('rejected');
    // The read decides: the readback operation keeps polling the unresolved order.
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    expect((await opOf(w, a.order_id, 'readback')).state).toBe('unknown');
    expect((await invariants())['INV5']).toBe(true);
    expect(w.paypal.count('capture')).toBe(2);
  });

  it('D-014: a same-key resend does not use the cap of new-key attempts', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({ kind: 'timeout' }); // the answer is lost
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: null, debug_id: 'DBGPA' }); // the resend: payer action
    w.tick(60_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    // The buyer comes back: a new key is allowed (it is the first NEW-key attempt).
    const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    expect(r.ok && r.value.status).toBe('paid');
    const keys = w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id);
    expect(keys).toEqual([`umsK-${a.order_ref}`, `umsK-${a.order_ref}`, `umsK-${a.order_ref}-2`]);
  });

  it('D-014: the total of sends stays bounded', async () => {
    w = await makeWorld();
    const a = await approved(w);
    for (let k = 0; k < 8; k += 1) {
      w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: null, debug_id: 'DBGPA' });
      await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    }
    expect(w.paypal.count('capture')).toBeLessThanOrEqual(4);
  });
});
