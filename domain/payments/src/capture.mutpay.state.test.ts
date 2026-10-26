// Mutation survivors of capture.ts (MUT-PAY): the gate (an order that is not ours, the missing
// operation row, the cap on sends), and the record of an answer when the order moved on while the
// call was open. Real PGlite, scripted PayPal. captureOnce is called directly, as the buyer's
// return does after its pre-capture read.
import { afterEach, describe, expect, it } from 'vitest';
import { captureOnce, claimPrecheck } from './capture';
import { loadOrder } from './store';
import type { CaptureOutcome } from './capture';
import {
  alertKinds,
  approved,
  makeWorld,
  opOf,
  ops,
  orderStatus,
  paid,
  setOrderStatus,
} from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

type Res = Parameters<OpsWorld['paypal']['queue']['capture']['push']>[0];
const rejected = (http: 400 | 403 | 422, issue: string): Res => ({
  kind: 'rejected',
  http,
  name: 'X',
  issue,
  debug_id: 'D',
});
const PAYER_ACTION: Res = {
  kind: 'payer_action',
  redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=t',
  debug_id: null,
};

async function send(a: Awaiting): Promise<CaptureOutcome> {
  const order = (await loadOrder(w.db, a.order_id))!;
  return captureOnce(w.deps, order, a.provider_order_id, null);
}
/** While the call is open, someone else moves the order to `status`. */
function moveDuringCall(status: string, order_id: string): void {
  const real = w.paypal.captureOrder.bind(w.paypal);
  w.paypal.captureOrder = async (r) => {
    await setOrderStatus(w.db, order_id, status);
    return real(r);
  };
}

describe('the gate', () => {
  it('an order that is not waiting for the buyer is lost: no call, no error', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const calls = w.paypal.count('capture');
    expect(await send(a)).toEqual({ kind: 'lost' });
    expect(w.paypal.count('capture')).toBe(calls);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('a first send needs no earlier pre-gate: the operation row is made and the capture goes', async () => {
    w = await makeWorld();
    const a = await approved(w);
    expect(await ops(w, a.order_id)).toEqual([expect.objectContaining({ kind: 'create' })]);
    expect(await send(a)).toEqual({ kind: 'claim' });
    const op = await opOf(w, a.order_id, 'capture');
    expect([op.state, op.attempt]).toEqual(['confirmed', 1]);
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('at most 2 x (1 + retries) sends are ever made: the 5th is refused with an alert, the 4th goes', async () => {
    for (const [attempt, want] of [
      [3, 'claim'],
      [4, 'capped'],
    ] as const) {
      w = await makeWorld();
      const a = await approved(w);
      const order = (await loadOrder(w.db, a.order_id))!;
      expect(await claimPrecheck(w.deps, order)).toBe(true);
      // A capture that was sent before, whose answer was lost, and is claimable again.
      await w.db.query(
        "UPDATE operations SET attempt = $2, first_sent_at = $3, lease_until = $3 WHERE order_id = $1 AND kind = 'capture'",
        [a.order_id, attempt, w.clock.now().toISOString()],
      );
      const calls = w.paypal.count('capture');
      expect(await captureOnce(w.deps, order, a.provider_order_id, null)).toEqual({ kind: want });
      if (want === 'capped') {
        expect(w.paypal.count('capture')).toBe(calls);
        expect(await alertKinds(w, a.order_id)).toEqual(['payment_unresolved']);
        expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
      } else {
        expect(w.paypal.count('capture')).toBe(calls + 1);
      }
      if (attempt === 3) await w.close();
    }
  });
});

describe('an answer that arrives after the order moved on', () => {
  const closedAs: Array<[string, string, string]> = [
    ['frozen', 'failed', 'mismatch'],
    ['failed', 'failed', 'declined'],
    ['abandoned', 'failed', 'declined'],
    ['paid', 'confirmed', ''],
    ['paid_partial', 'confirmed', ''],
  ];
  for (const [status, state, reason] of closedAs) {
    it(`${status} meanwhile + no answer: the operation is closed as ${state}${reason === '' ? '' : ` (${reason})`}, the order is not touched`, async () => {
      w = await makeWorld();
      const a = await approved(w);
      moveDuringCall(status, a.order_id);
      w.paypal.queue.capture.push({ kind: 'timeout' });
      expect(await send(a)).toEqual({ kind: 'unknown' });
      expect(await orderStatus(w, a.order_id)).toBe(status);
      const op = await opOf(w, a.order_id, 'capture');
      expect([op.state, op.failure_reason]).toEqual([state, reason === '' ? null : reason]);
      expect(op.next_retry_at).toBeNull();
    });
  }
  for (const [status, want] of [
    ['frozen', { kind: 'frozen' }],
    ['abandoned', { kind: 'lost' }],
  ] as const) {
    it(`${status} meanwhile + the payer must act again: ${want.kind}, the operation is closed, no redirect is stored`, async () => {
      w = await makeWorld();
      const a = await approved(w);
      const url = (
        await w.rows<{ approve_url: string }>('SELECT approve_url FROM provider_orders')
      )[0]!.approve_url;
      moveDuringCall(status, a.order_id);
      w.paypal.queue.capture.push(PAYER_ACTION);
      expect(await send(a)).toEqual(want);
      expect((await opOf(w, a.order_id, 'capture')).state).toBe('failed');
      expect(
        (await w.rows<{ approve_url: string }>('SELECT approve_url FROM provider_orders'))[0]!
          .approve_url,
      ).toBe(url);
    });
  }
  it('frozen meanwhile + another refusal: frozen is reported, the order stays as it is', async () => {
    w = await makeWorld();
    const a = await approved(w);
    moveDuringCall('frozen', a.order_id);
    w.paypal.queue.capture.push(rejected(422, 'INSTRUMENT_DECLINED'));
    expect(await send(a)).toEqual({ kind: 'frozen' });
    expect(await orderStatus(w, a.order_id)).toBe('frozen');
  });
  it('abandoned meanwhile + another refusal: lost', async () => {
    w = await makeWorld();
    const a = await approved(w);
    moveDuringCall('abandoned', a.order_id);
    w.paypal.queue.capture.push(rejected(422, 'INSTRUMENT_DECLINED'));
    expect(await send(a)).toEqual({ kind: 'lost' });
  });
  it('a claim after the order moved on does not start a read-back operation', async () => {
    w = await makeWorld();
    const a = await approved(w);
    moveDuringCall('abandoned', a.order_id);
    expect(await send(a)).toEqual({ kind: 'claim' });
    expect((await ops(w, a.order_id)).map((o) => o.kind).sort()).toEqual(['capture', 'create']);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
  });
});

describe('claims of several units', () => {
  it.each([['in order'], ['reversed']] as const)(
    'the same capture id claimed for two units (%s) is stored once, on the first reference',
    async (how) => {
      w = await makeWorld();
      const a = await approved(w, { offers: ['ofr_1', 'ofr_3'], d1: true });
      const units = await w.rows<{ reference_id: string }>(
        'SELECT reference_id FROM order_units WHERE order_id = $1 ORDER BY reference_id',
        [a.order_id],
      );
      expect(units).toHaveLength(2);
      const claims = units.map((u) => ({
        reference_id: u.reference_id,
        capture_id: 'SBXSAMECAPTURE',
        status: 'COMPLETED' as const,
      }));
      w.paypal.queue.capture.push({
        kind: 'claim',
        http: 201,
        provider_order_id: a.provider_order_id,
        units: how === 'in order' ? claims : [...claims].reverse(),
        debug_id: 'D',
      });
      expect(await send(a)).toEqual({ kind: 'claim' });
      const stored = await w.rows<{ reference_id: string; capture_id: string | null }>(
        'SELECT reference_id, capture_id FROM order_units WHERE order_id = $1 ORDER BY reference_id',
        [a.order_id],
      );
      expect(stored.map((s) => s.capture_id)).toEqual(['SBXSAMECAPTURE', null]);
    },
  );
});

describe('a duplicate-invoice refusal', () => {
  it('freezes the order and marks it as a mismatch', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push(rejected(422, 'DUPLICATE_INVOICE_ID'));
    expect(await send(a)).toEqual({ kind: 'frozen' });
    const row = (
      await w.rows<{ status: string; mismatch: boolean }>(
        'SELECT status, mismatch FROM orders WHERE id = $1',
        [a.order_id],
      )
    )[0]!;
    expect(row).toEqual({ status: 'frozen', mismatch: true });
  });
});
