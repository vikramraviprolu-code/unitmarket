// Mutation survivors of reconcile.ts (FIX-PAY2): the capture re-send when the order moved on while
// the call was open, the 400 alert, a blocked call, the read-back operation after a refusal, and
// the create re-send's duplicate and origin rules. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { beginCheckout } from './index';
import { resendCreate, retryCapture } from './reconcile';
import { loadOperation, loadOrder } from './store';
import {
  BUYER_A,
  alertKinds,
  deadCapture,
  makeWorld,
  opOf,
  orderStatus,
  place,
  START,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

type Res = Parameters<OpsWorld['paypal']['queue']['capture']['push']>[0];
const rejected = (http: number, issue: string): Res => ({
  kind: 'rejected',
  http,
  name: 'X',
  issue,
  debug_id: 'D',
});

/** A capture the process never sent, made due: the next retry is claimable by hand. */
async function readyRetry(): Promise<{
  a: Awaited<ReturnType<typeof deadCapture>>;
  order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
  op: NonNullable<Awaited<ReturnType<typeof loadOperation>>>;
}> {
  const a = await deadCapture(w);
  w.tick(61_000);
  await w.db.query(
    "UPDATE operations SET state = 'unknown', next_retry_at = $2, reconcile_until = $3 WHERE order_id = $1 AND kind = 'capture'",
    [
      a.order_id,
      w.clock.now().toISOString(),
      new Date(Date.parse(START) + 86_400_000).toISOString(),
    ],
  );
  const order = (await loadOrder(w.db, a.order_id))!;
  const op = (await loadOperation(w.db, a.order_id, 'capture'))!;
  return { a, order, op };
}
/** While the re-send is open, the order is moved to `status` by someone else. */
function moveDuringCall(status: string, order_id: string): void {
  const real = w.paypal.captureOrder.bind(w.paypal);
  w.paypal.captureOrder = async (r) => {
    await w.db.query('UPDATE orders SET status = $2 WHERE id = $1', [order_id, status]);
    return real(r);
  };
}

describe('retryCapture when the order moved on while the call was open', () => {
  const answers: Array<[string, Res, 'lost' | 'unknown']> = [
    ['timeout', { kind: 'timeout' }, 'unknown'],
    [
      'payer_action',
      {
        kind: 'payer_action',
        redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=t',
        debug_id: null,
      },
      'lost',
    ],
    ['ORDER_NOT_APPROVED', rejected(422, 'ORDER_NOT_APPROVED'), 'lost'],
    ['another refusal', rejected(422, 'SOMETHING_ELSE'), 'unknown'],
  ];
  for (const [name, res, want] of answers) {
    it(`frozen meanwhile + ${name}: the operation fails as mismatch, the order stays frozen, nothing is raised`, async () => {
      w = await makeWorld();
      const { a, order, op } = await readyRetry();
      moveDuringCall('frozen', a.order_id);
      w.paypal.queue.capture.push(res);
      expect(await retryCapture(w.deps, order, op, a.provider_order_id)).toBe(want);
      expect(await orderStatus(w, a.order_id)).toBe('frozen');
      expect(await opOf(w, a.order_id, 'capture')).toMatchObject({
        state: 'failed',
        failure_reason: 'mismatch',
      });
      expect(await alertKinds(w, a.order_id)).toEqual([]);
    });
    it(`paid meanwhile + ${name}: the operation is confirmed and the order is not touched`, async () => {
      w = await makeWorld();
      const { a, order, op } = await readyRetry();
      moveDuringCall('paid', a.order_id);
      w.paypal.queue.capture.push(res);
      expect(await retryCapture(w.deps, order, op, a.provider_order_id)).toBe(want);
      expect(await orderStatus(w, a.order_id)).toBe('paid');
      expect((await opOf(w, a.order_id, 'capture')).state).toBe('confirmed');
    });
    it(`failed meanwhile + ${name}: the operation is left as it is, the order stays failed`, async () => {
      w = await makeWorld();
      const { a, order, op } = await readyRetry();
      moveDuringCall('failed', a.order_id);
      w.paypal.queue.capture.push(res);
      expect(await retryCapture(w.deps, order, op, a.provider_order_id)).toBe(want);
      expect(await orderStatus(w, a.order_id)).toBe('failed');
      expect((await opOf(w, a.order_id, 'capture')).state).toBe('sent');
    });
  }
  it('a duplicate-invoice refusal freezes the order whatever state it was in', async () => {
    w = await makeWorld();
    const { a, order, op } = await readyRetry();
    w.paypal.queue.capture.push(rejected(422, 'DUPLICATE_INVOICE_ID'));
    expect(await retryCapture(w.deps, order, op, a.provider_order_id)).toBe('frozen');
    expect(await orderStatus(w, a.order_id)).toBe('frozen');
    expect(await alertKinds(w, a.order_id)).toEqual(['frozen_order']);
  });
});

describe('retryCapture refusals and blocked calls', () => {
  it('a 400 refusal raises payment_unresolved; a 422 refusal raises nothing', async () => {
    w = await makeWorld();
    const x = await readyRetry();
    w.paypal.queue.capture.push(rejected(400, 'INVALID'));
    expect(await retryCapture(w.deps, x.order, x.op, x.a.provider_order_id)).toBe('unknown');
    expect(await alertKinds(w, x.a.order_id)).toEqual(['payment_unresolved']);
    await w.close();

    w = await makeWorld();
    const y = await readyRetry();
    w.paypal.queue.capture.push(rejected(422, 'INVALID'));
    expect(await retryCapture(w.deps, y.order, y.op, y.a.provider_order_id)).toBe('unknown');
    expect(await alertKinds(w, y.a.order_id)).toEqual([]);
  });
  it('a refusal makes sure a read-back operation exists to poll the order', async () => {
    w = await makeWorld();
    const { a, order, op } = await readyRetry();
    await w.db.query("DELETE FROM operations WHERE order_id = $1 AND kind = 'readback'", [
      a.order_id,
    ]);
    w.paypal.queue.capture.push(rejected(422, 'INVALID'));
    await retryCapture(w.deps, order, op, a.provider_order_id);
    expect((await opOf(w, a.order_id, 'readback')).state).toBe('unknown');
  });
  it('a blocked call spends no attempt', async () => {
    w = await makeWorld();
    const { a, order, op } = await readyRetry();
    w.paypal.queue.capture.push({ kind: 'blocked', by: 'budget' });
    expect(await retryCapture(w.deps, order, op, a.provider_order_id)).toBe('unknown');
    expect((await opOf(w, a.order_id, 'capture')).attempt).toBe(op.attempt);
  });
  it('a blocked call after the order moved on does not touch the attempt either way', async () => {
    w = await makeWorld();
    const { a, order, op } = await readyRetry();
    moveDuringCall('frozen', a.order_id);
    w.paypal.queue.capture.push({ kind: 'blocked', by: 'budget' });
    await retryCapture(w.deps, order, op, a.provider_order_id);
    expect((await opOf(w, a.order_id, 'capture')).attempt).toBe(op.attempt + 1);
  });
});

describe('resendCreate', () => {
  it('a duplicate-invoice refusal freezes the order and alerts', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({ kind: 'timeout' });
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const order = (await loadOrder(w.db, p.order_id))!;
    const op = (await loadOperation(w.db, p.order_id, 'create'))!;
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 422,
      name: 'X',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    expect(await resendCreate(w.deps, order, op)).toBe('failed');
    expect(await orderStatus(w, p.order_id)).toBe('frozen');
    expect(await alertKinds(w, p.order_id)).toEqual(['frozen_order']);
    expect(await opOf(w, p.order_id, 'create')).toMatchObject({
      state: 'failed',
      failure_reason: 'rejected',
    });
  });
  it('refuses return and cancel URLs outside the configured origin', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({ kind: 'timeout' });
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const order = (await loadOrder(w.db, p.order_id))!;
    const op = (await loadOperation(w.db, p.order_id, 'create'))!;
    const calls = w.paypal.count('create');
    const bad = { ...w.deps, config: { ...w.deps.config, public_origin: 'not an origin' } };
    await expect(resendCreate(bad, order, op)).rejects.toThrow(/public origin/);
    expect(w.paypal.count('create')).toBe(calls);
  });
});
