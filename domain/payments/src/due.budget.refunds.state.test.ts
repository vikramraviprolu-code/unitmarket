// BU-5 R1, on the tree with BU-4 merged: a refund that was put off (the order read for the
// remaining amount was not available, so nothing was ever sent) has an unknown operation with no
// first_sent_at and a 24 h reconcile_until. A money_only pass must not send it: money_only never
// sends, and a spent polling allowance must not spend the capture reserve on a refund POST.
// Real PGlite, scripted PayPal. Synthetic rows only, no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRefund, requestRefund, runDue } from './index';
import { OPERATOR, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

vi.setConfig({ testTimeout: 120_000 });

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;
const unavailable = { kind: 'unavailable', retry_after_ms: null } as const;

async function putOff() {
  w = await makeRemainingWorld({ price: 500 });
  const a = await paid(w);
  w.markReads();
  const unit = (
    await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
  )[0]!;
  const r = await requestRefund(w.deps, {
    unit_id: unit.id,
    amount: { currency: 'USD', minor: 200 },
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  w.script(unavailable);
  await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
  const op = (
    await w.rows<{ state: string; first_sent_at: Date | null }>(
      "SELECT state, first_sent_at FROM operations WHERE order_id = $1 AND kind = 'refund'",
      [a.order_id],
    )
  )[0]!;
  expect(op.state).toBe('unknown');
  expect(op.first_sent_at).toBeNull(); // put off: nothing was ever sent
  return { a, rq: r.value.refund_request_id };
}
const refundState = async (rq: string) =>
  (await w.rows<{ state: string }>('SELECT state FROM refund_requests WHERE id = $1', [rq]))[0]!
    .state;

describe('R1: money_only does not send a put-off refund', () => {
  it('a put-off refund past its 24 h window: a money_only pass sends nothing and reads nothing', async () => {
    const { rq } = await putOff();
    w.tick(DAY + 1000);
    const reads = w.reads();
    const r = await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect(w.sends()).toHaveLength(0);
    expect(w.reads()).toBe(reads);
    expect(r.processed).toBe(0);
    expect(await refundState(rq)).toBe('requested');
  });

  it('a put-off refund inside its window: money_only leaves it, an all pass sends it once', async () => {
    const { rq } = await putOff();
    w.tick(2 * 60_000);
    await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect(w.sends()).toHaveLength(0);
    await runDue(w.deps, { max_items: 10, allow: 'all' });
    expect(w.sends()).toHaveLength(1);
    expect(await refundState(rq)).not.toBe('requested');
  });

  it('a refund that WAS sent and whose 24 h window ended is still closed by a money_only pass (no second send)', async () => {
    w = await makeRemainingWorld({ price: 500 });
    const a = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!;
    w.refundNext.lose_response = true;
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: { currency: 'USD', minor: 200 },
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    w.markReads();
    const sent = w.sends().length;
    expect(sent).toBe(1);
    w.tick(DAY + 1000);
    await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect(w.sends()).toHaveLength(sent); // closed after a read, never sent again
    const op = (
      await w.rows<{ state: string }>(
        "SELECT state FROM operations WHERE order_id = $1 AND kind = 'refund'",
        [a.order_id],
      )
    )[0]!;
    expect(op.state).toBe('failed');
  });
});
