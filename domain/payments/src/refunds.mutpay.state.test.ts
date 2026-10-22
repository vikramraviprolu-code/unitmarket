// Mutation survivors of refunds.ts (MUT-PAY): how a refused refund is recorded, the end state of a
// refund PayPal failed or cancelled, the link from a refund entry to its sale, a replayed booking,
// and the 24 h window of a refund that stays PENDING. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { executeRefund, requestRefund, runDue } from './index';
import { readBack } from './refunds';
import { OPERATOR, alertKinds, makeWorld, ops, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const unitOf = async (order_id: string) =>
  (
    await w.rows<{ id: string; refunded_minor: number }>(
      'SELECT id, refunded_minor FROM order_units WHERE order_id = $1',
      [order_id],
    )
  )[0]!;
async function refund(unit_id: string, minor: number): Promise<string> {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: { currency: 'USD', minor },
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.refund_request_id;
}
const requestState = async (id: string): Promise<string> =>
  (await w.rows<{ state: string }>('SELECT state FROM refund_requests WHERE id = $1', [id]))[0]!
    .state;

describe('a refund PayPal refuses', () => {
  it.each([
    [400, 'invalid_request'],
    [403, 'rejected'],
    [422, 'rejected'],
  ] as const)('http %i is recorded as %s', async (http, reason) => {
    w = await makeWorld();
    const a = await paid(w);
    w.paypal.refundCapture = () =>
      Promise.resolve({ kind: 'rejected', http, name: 'X', issue: 'ISSUE', debug_id: null });
    const id = await refund((await unitOf(a.order_id)).id, 100);
    expect(await executeRefund(w.deps, { refund_request_id: id })).toEqual({
      ok: false,
      error: { code: 'rejected' },
    });
    const op = (await ops(w, a.order_id)).find((o) => o.kind === 'refund')!;
    expect([op.state, op.failure_reason]).toEqual(['failed', reason]);
    expect(await requestState(id)).toBe('rejected');
  });
});

describe('a refund that ends without money going back', () => {
  it.each([
    ['FAILED', 'failed'],
    ['CANCELLED', 'cancelled'],
  ] as const)('PayPal says %s: the request is %s and a human is told', async (status, state) => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.status = status;
    const id = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: id });
    expect(await requestState(id)).toBe(state);
    expect(await alertKinds(w, a.order_id)).toContain('refund_failed');
    expect((await unitOf(a.order_id)).refunded_minor).toBe(0);
  });
});

describe('the booking of a refund', () => {
  it('the refund entry points at the sale of the same capture', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const id = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: id });
    const sale = (
      await w.rows<{ id: string }>("SELECT id FROM ledger_entries WHERE kind = 'sale'")
    )[0]!;
    const entry = (
      await w.rows<{ ref_entry_id: string | null }>(
        "SELECT ref_entry_id FROM ledger_entries WHERE kind = 'refund'",
      )
    )[0]!;
    expect(entry.ref_entry_id).toBe(sale.id);
  });
  it('a booking replayed for a request that is pending again changes nothing', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const id = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: id });
    expect((await unitOf(a.order_id)).refunded_minor).toBe(100);
    // As if the process died after the ledger entry but before the request was marked completed.
    await w.db.query("UPDATE refund_requests SET state = 'pending' WHERE id = $1", [id]);
    expect(await readBack(w.deps, id)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect((await unitOf(a.order_id)).refunded_minor).toBe(100);
    expect(
      (
        await w.rows<{ n: number }>(
          "SELECT count(*)::int AS n FROM ledger_entries WHERE kind = 'refund'",
        )
      )[0]!.n,
    ).toBe(1);
    expect(await requestState(id)).toBe('completed');
  });
});

describe('a refund that stays PENDING', () => {
  it('is read again until its 24 h window ends, then closed with one alert for a human', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.read_status = 'PENDING';
    const id = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: id });
    w.tick(31_000);
    const open = await runDue(w.deps, { max_items: 10 });
    expect(open.expired).toBe(0);
    expect(open.still_unknown).toBe(1);
    expect(await alertKinds(w, a.order_id)).toEqual([]);
    w.tick(24 * H);
    const closed = await runDue(w.deps, { max_items: 10 });
    expect(closed.expired).toBe(1);
    expect(await alertKinds(w, a.order_id)).toEqual(['refund_unresolved']);
    const op = (await ops(w, a.order_id)).find((o) => o.kind === 'refund_readback')!;
    expect([op.state, op.failure_reason]).toEqual(['failed', 'window_expired']);
    expect((await unitOf(a.order_id)).refunded_minor).toBe(0);
  });
});
