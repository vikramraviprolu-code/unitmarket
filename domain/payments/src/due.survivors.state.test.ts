// Mutation survivors of due.ts (MUT-PAY): the budget of a pass, the failure path of one item,
// terminal orders, a blocked read, the capture re-send limits, the end of the 24 h window, the
// race of the abandon sweep and the switch re-read inside it. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { beginCheckout, executeRefund, requestRefund, runDue } from './index';
import { markUnknown, nextPollAt } from './due';
import { insertOperation } from './store';
import type { OrderRead } from '@umsbx/contracts';
import {
  BUYER_A,
  OPERATOR,
  alertKinds,
  awaiting,
  count,
  deadCapture,
  lostResponse,
  makeWorld,
  opOf,
  orderStatus,
  paid,
  place,
  sentCapture,
  setOrderStatus,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;
const EMPTY = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };
const BLOCKED: OrderRead = { kind: 'blocked', by: 'dry_run_miss' };

/** The order as PayPal shows it before any approval: nothing captured, not APPROVED. */
async function unpaidRead(provider_order_id: string): Promise<OrderRead> {
  const real = await w.paypal.getOrder(provider_order_id);
  if (real.kind !== 'order') throw new Error('expected an order read');
  return { ...real, status: 'CREATED', units: real.units.map((u) => ({ ...u, capture: null })) };
}
const providerOf = async (order_id: string): Promise<string> =>
  (
    await w.rows<{ provider_order_id: string }>(
      'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
      [order_id],
    )
  )[0]!.provider_order_id;

describe('budget of a pass', () => {
  it('each processed item costs exactly one: a budget of 3 serves three orders', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    const b = await lostResponse(w, { buyer_id: 'buy_B' });
    const c = await lostResponse(w, { offers: ['ofr_2'] });
    w.tick(31_000);
    const r = await runDue(w.deps, { max_items: 3 });
    expect(r.processed).toBe(3);
    for (const x of [a, b, c]) expect(await orderStatus(w, x.order_id)).toBe('paid');
  });
});

describe('an item that fails', () => {
  it('is logged, and its operation is polled again on the backoff schedule', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(31_000);
    w.paypal.beforeGet = () => Promise.reject(new Error('boom'));
    const r = await runDue(w.deps, { max_items: 10 });
    w.paypal.beforeGet = null;
    expect(r.processed).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    const op = (
      await w.rows<{
        state: string;
        next_retry_at: Date;
        first_sent_at: Date | null;
        created_at: Date;
        reconcile_until: Date;
      }>(
        "SELECT state, next_retry_at, first_sent_at, created_at, reconcile_until FROM operations WHERE order_id = $1 AND kind = 'capture'",
        [a.order_id],
      )
    )[0]!;
    expect(op.state).toBe('unknown');
    const expected = nextPollAt(
      w.deps.config,
      (op.first_sent_at ?? op.created_at).toISOString(),
      w.clock.now().toISOString(),
      op.reconcile_until.toISOString(),
    );
    expect(op.next_retry_at.toISOString()).toBe(expected);
    // Not the lease of the claim (60 s from now): the schedule moved it further.
    expect(op.next_retry_at.getTime()).toBeGreaterThan(w.clock.now().getTime() + 60_000);
  });
});

describe('orders the reconciler leaves alone', () => {
  it('a frozen order closes its unknown operations as mismatch, a failed or abandoned one as declined, without a read', async () => {
    w = await makeWorld();
    const frozen = await lostResponse(w);
    const failed = await lostResponse(w, { buyer_id: 'buy_B' });
    const abandoned = await lostResponse(w, { offers: ['ofr_2'] });
    await w.db.query("UPDATE orders SET status = 'frozen' WHERE id = $1", [frozen.order_id]);
    await w.db.query("UPDATE orders SET status = 'failed' WHERE id = $1", [failed.order_id]);
    await w.db.query("UPDATE orders SET status = 'abandoned' WHERE id = $1", [abandoned.order_id]);
    const gets = w.paypal.count('get');
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(gets);
    const reason = async (id: string) => {
      const op = await opOf(w, id, 'capture');
      return [op.state, op.failure_reason, op.next_retry_at];
    };
    expect(await reason(frozen.order_id)).toEqual(['failed', 'mismatch', null]);
    expect(await reason(failed.order_id)).toEqual(['failed', 'declined', null]);
    expect(await reason(abandoned.order_id)).toEqual(['failed', 'declined', null]);
    expect(await orderStatus(w, frozen.order_id)).toBe('frozen');
  });
});

describe('a read that is blocked', () => {
  it('pauses the item: the operation keeps its due time and nothing is counted as still unknown', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(31_000);
    const before = (await opOf(w, a.order_id, 'capture')).next_retry_at!.toISOString();
    w.paypal.queue.get.push(BLOCKED);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r).toEqual({ ...EMPTY, processed: 1 });
    const op = await opOf(w, a.order_id, 'capture');
    expect(op.state).toBe('unknown');
    expect(op.next_retry_at!.toISOString()).toBe(before);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    // Once PayPal answers again the same operation is read and settled.
    expect((await runDue(w.deps, { max_items: 10 })).processed).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('the read after a capture re-send is blocked: paused, not counted, due time kept', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.tick(61_000);
    w.paypal.queue.get.push('real', BLOCKED);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.still_unknown).toBe(0);
    expect(r.processed).toBe(1);
    expect(w.paypal.count('capture')).toBe(2); // the dead send and the one re-send
    // The next pass reads again and books the capture.
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(w.paypal.count('capture')).toBe(2);
  });
});

describe('the capture re-send rules inside a pass', () => {
  it('after the one re-send was lost, an APPROVED order without capture is not sent a third time', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.tick(61_000);
    w.paypal.queue.capture.push({ kind: 'timeout' }); // the re-send gets no answer and never happens
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(2);
    expect((await opOf(w, a.order_id, 'capture')).attempt).toBe(2);
    w.tick(2 * H); // still inside the 5 h window of the first send
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(2);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
  });
  it('content that is not ready blocks the re-send until it is', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    const head = w.content.heads.get('key-art_1')!;
    w.content.heads.delete('key-art_1');
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(1); // only the one that died
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    w.content.heads.set('key-art_1', head);
    w.tick(10 * 60_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(2);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
});

describe('the end of the 24 h window', () => {
  it('polls while the window is open and closes the operation with one alert at its end', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    const provider = await providerOf(a.order_id);
    w.tick(31_000);
    w.paypal.queue.get.push(await unpaidRead(provider));
    const open = await runDue(w.deps, { max_items: 10 });
    expect(open).toEqual({ ...EMPTY, processed: 1, still_unknown: 1 });
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('unknown');
    expect(await alertKinds(w, a.order_id)).toEqual([]);

    w.tick(DAY);
    w.paypal.queue.get.push(await unpaidRead(provider));
    const closed = await runDue(w.deps, { max_items: 10 });
    expect(closed.expired).toBe(1);
    expect(closed.still_unknown).toBe(0);
    const op = await opOf(w, a.order_id, 'capture');
    expect([op.state, op.failure_reason, op.next_retry_at]).toEqual([
      'failed',
      'window_expired',
      null,
    ]);
    expect(await alertKinds(w, a.order_id)).toEqual(['payment_unresolved']);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    await runDue(w.deps, { max_items: 10 });
    expect(await count(w, 'alerts', "kind = 'payment_unresolved'")).toBe(1);
  });
  it('an operation of an order that is already paid closes without an alert', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const at = w.clock.now().toISOString();
    const inserted = await w.db.transaction((tx) =>
      insertOperation(tx, {
        id: 'opr_stale_readback',
        order_id: a.order_id,
        kind: 'readback',
        state: 'unknown',
        request_id: 'readback-stale-1',
        lease_until: null,
        reconcile_until: at,
        next_retry_at: at,
        at,
      }),
    );
    expect(inserted).toBe(true);
    w.tick(1000);
    await runDue(w.deps, { max_items: 10 });
    const op = (
      await w.rows<{ state: string; failure_reason: string | null }>(
        "SELECT state, failure_reason FROM operations WHERE id = 'opr_stale_readback'",
      )
    )[0]!;
    expect(op).toEqual({ state: 'failed', failure_reason: 'window_expired' });
    expect(await alertKinds(w, a.order_id)).toEqual([]);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
});

describe('a create that is closed after 5 h with a provider order on record', () => {
  async function lostCreate() {
    const p = await place(w);
    w.paypal.queue.create.push({ kind: 'timeout' });
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c.ok).toBe(false);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('unknown');
    return p;
  }
  it('the order stays unresolved and its items are not released', async () => {
    w = await makeWorld();
    const p = await lostCreate();
    await w.db.query(
      "UPDATE provider_orders SET provider_order_id = 'SBXFAKEORD99999' WHERE order_id = $1",
      [p.order_id],
    );
    w.tick(5 * H + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.expired).toBe(1);
    expect(await orderStatus(w, p.order_id)).toBe('unresolved');
    expect(await alertKinds(w, p.order_id)).toEqual(['payment_unresolved']);
    expect(await count(w, 'entitlements', "money_state = 'denied'")).toBe(0);
  });
  it('an order that moved on since is not resent: the operation is confirmed', async () => {
    w = await makeWorld();
    const p = await lostCreate();
    await w.db.query(
      "UPDATE provider_orders SET provider_order_id = 'SBXFAKEORD99999' WHERE order_id = $1",
      [p.order_id],
    );
    await setOrderStatus(w.db, p.order_id, 'awaiting_buyer');
    const creates = w.paypal.count('create');
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('create')).toBe(creates);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('confirmed');
    expect(await orderStatus(w, p.order_id)).toBe('awaiting_buyer');
  });
});

describe('refunds in a pass and after a dead process', () => {
  const unit = async (order_id: string) =>
    (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [order_id])
    )[0]!;
  it('a refund whose answer was lost and whose window ended is counted as expired, once', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.lose_response = true;
    const asked = await requestRefund(w.deps, {
      unit_id: (await unit(a.order_id)).id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!asked.ok) throw new Error('refund not requested');
    await executeRefund(w.deps, { refund_request_id: asked.value.refund_request_id });
    w.tick(5 * H + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r).toMatchObject({ still_unknown: 0, expired: 1, abandoned: 0 });
    expect(w.refundCalls).toHaveLength(1);
  });
  it('markUnknown also moves the request of a refund that was in flight', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.lose_response = true;
    const asked = await requestRefund(w.deps, {
      unit_id: (await unit(a.order_id)).id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!asked.ok) throw new Error('refund not requested');
    await executeRefund(w.deps, { refund_request_id: asked.value.refund_request_id });
    const op = await opOf(w, a.order_id, 'refund');
    // As if the process had died before it learned the outcome.
    await w.db.query(
      "UPDATE operations SET state = 'sent', lease_until = $2, next_retry_at = NULL WHERE id = $1",
      [op.id, new Date(w.clock.now().getTime() + 60_000).toISOString()],
    );
    await w.db.query("UPDATE refund_requests SET state = 'sent' WHERE id = $1", [
      asked.value.refund_request_id,
    ]);
    const moved = await w.db.transaction((tx) =>
      markUnknown(
        tx,
        w.deps,
        {
          id: op.id,
          order_id: a.order_id,
          kind: 'refund',
          first_sent_at: null,
          request_id: op.request_id,
        },
        'sent',
      ),
    );
    expect(moved).toBe(true);
    expect((await opOf(w, a.order_id, 'refund')).state).toBe('unknown');
    expect((await w.rows<{ state: string }>('SELECT state FROM refund_requests'))[0]!.state).toBe(
      'unknown',
    );
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('markUnknown sends the order of a capture in flight back to unresolved, and only that', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    const op = await opOf(w, a.order_id, 'capture');
    const moved = await w.db.transaction((tx) =>
      markUnknown(
        tx,
        w.deps,
        {
          id: op.id,
          order_id: a.order_id,
          kind: 'capture',
          first_sent_at: null,
          request_id: op.request_id,
        },
        'sent',
      ),
    );
    expect(moved).toBe(true);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
  });
});

describe('the abandon sweep', () => {
  it('an order that left awaiting_buyer while PayPal was asked is not abandoned and its items stay', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.tick(DAY + 1000);
    w.paypal.beforeGet = async () => {
      w.paypal.beforeGet = null;
      await w.db.query("UPDATE orders SET status = 'failed' WHERE id = $1", [a.order_id]);
    };
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r).toEqual({ ...EMPTY, processed: 1 }); // looked at, then left to whoever moved it
    expect(await orderStatus(w, a.order_id)).toBe('failed');
    expect(await count(w, 'order_units', "status = 'declined'")).toBe(0);
    expect(await count(w, 'entitlements', "money_state = 'denied'")).toBe(0);
  });
  it('the outbound switch is read again before each read of the sweep', async () => {
    w = await makeWorld();
    const waiting = await awaiting(w);
    await lostResponse(w, { buyer_id: 'buy_B' });
    w.tick(DAY + 1000);
    // The first read of the pass (the lost capture) finds the switch turned off meanwhile.
    w.paypal.beforeGet = async () => {
      w.paypal.beforeGet = null;
      w.switches.paypal_outbound = false;
    };
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(0);
    expect(await orderStatus(w, waiting.order_id)).toBe('awaiting_buyer');
    expect(
      w.paypal.calls.filter(
        (c) => c.op === 'get' && c.provider_order_id === waiting.provider_order_id,
      ),
    ).toHaveLength(0);
  });
});
