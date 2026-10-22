// Mutation survivors of refunds.ts (FIX-PAY2): input validation, answers for settled requests, the
// read-back operation reset, booking against the reported total, and closing an unknown refund.
// Real PGlite, scripted PayPal. Synthetic rows only.
import { afterEach, describe, expect, it } from 'vitest';
import { executeRefund, requestRefund, runDue } from './index';
import { ensureRefundReadbackOp, readBack } from './refunds';
import { OPERATOR, alertKinds, makeWorld, ops, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  await w.close();
});
const H = 3_600_000;
const usd = (minor: number) => ({ currency: 'USD', minor });
const unitOf = async (order_id: string): Promise<string> =>
  (await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [order_id]))[0]!
    .id;
const refundRows = () =>
  w.rows<{ state: string; refund_id: string | null }>(
    'SELECT state, refund_id FROM refund_requests ORDER BY id',
  );
async function request(unit_id: string, minor: number | null): Promise<string> {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'x',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.refund_request_id;
}

describe('ids that are not ids', () => {
  it('requestRefund and executeRefund answer with an error result, never a thrown database error', async () => {
    w = await makeWorld();
    for (const bad of ['', 'nope', "x'; DROP TABLE orders; --"]) {
      expect(
        await requestRefund(w.deps, { unit_id: bad, amount: null, reason: 'x', actor: OPERATOR }),
      ).toEqual({ ok: false, error: { code: 'not_captured' } });
      expect(await executeRefund(w.deps, { refund_request_id: bad })).toEqual({
        ok: false,
        error: { code: 'rejected' },
      });
      expect(await readBack(w.deps, bad)).toEqual({ ok: false, error: { code: 'unknown' } });
    }
  });
});

describe('executeRefund on a request that is already settled', () => {
  it('a rejected request answers rejected, a request handed to a human answers unknown, no second call', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.refundNext.reject = true;
    const r1 = await request(u, 100);
    const first = await executeRefund(w.deps, { refund_request_id: r1 });
    expect(first).toEqual({ ok: false, error: { code: 'rejected' } });
    w.refundNext.reject = false;
    const calls = w.refundCalls.length;
    expect(await executeRefund(w.deps, { refund_request_id: r1 })).toEqual({
      ok: false,
      error: { code: 'rejected' },
    });
    await w.db.query("UPDATE refund_requests SET state = 'unresolved' WHERE id = $1", [r1]);
    expect(await executeRefund(w.deps, { refund_request_id: r1 })).toEqual({
      ok: false,
      error: { code: 'unknown' },
    });
    expect(w.refundCalls).toHaveLength(calls);
  });
});

describe('ensureRefundReadbackOp', () => {
  it('puts a closed read-back operation back to unknown and leaves a running one alone', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.refundNext.status = 'PENDING';
    const r1 = await request(u, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    const state = async () =>
      (
        await w.rows<{ state: string }>(
          "SELECT state FROM operations WHERE request_id = $1 AND kind = 'refund_readback'",
          [`umsRB-${r1}`],
        )
      )[0]!.state;
    const touch = (): Promise<void> =>
      w.db.transaction(async (tx) => {
        const at = w.clock.now().toISOString();
        await ensureRefundReadbackOp(tx, w.deps, r1, a.order_id, at, at);
      });
    expect(await state()).toBe('unknown');
    for (const closed of ['confirmed', 'failed']) {
      await w.db.query(
        "UPDATE operations SET state = $2, failure_reason = CASE WHEN $2 = 'failed' THEN 'window_expired' END, next_retry_at = NULL WHERE request_id = $1 AND kind = 'refund_readback'",
        [`umsRB-${r1}`, closed],
      );
      w.tick(1000);
      await touch();
      expect(await state()).toBe('unknown');
    }
    await w.db.query(
      "UPDATE operations SET state = 'sent', lease_until = $2 WHERE request_id = $1 AND kind = 'refund_readback'",
      [`umsRB-${r1}`, new Date(w.clock.now().getTime() + 60_000).toISOString()],
    );
    await touch();
    expect(await state()).toBe('sent');
  });
});

describe('booking against the total the order read reports', () => {
  it('a reported total that covers the refund books it, once, for a full and for a partial refund', async () => {
    w = await makeWorld();
    w.reportRefunded = true;
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.refundNext.status = 'PENDING';
    const r1 = await request(u, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    for (const r of w.refunds.values()) r.status = 'COMPLETED';
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await refundRows()).toEqual([{ state: 'completed', refund_id: expect.any(String) }]);
    const r2 = await request(u, 200);
    w.refundNext.status = 'PENDING';
    await executeRefund(w.deps, { refund_request_id: r2 });
    for (const r of w.refunds.values()) r.status = 'COMPLETED';
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows()).map((r) => r.state)).toEqual(['completed', 'completed']);
    expect(
      (
        await w.rows<{ amount_minor: number }>(
          "SELECT amount_minor FROM ledger_entries WHERE kind = 'refund' ORDER BY amount_minor",
        )
      ).map((r) => r.amount_minor),
    ).toEqual([100, 200]);
    expect(
      (await w.rows<{ refunded_minor: number }>('SELECT refunded_minor FROM order_units'))[0]!
        .refunded_minor,
    ).toBe(300);
  });
  it('a total that does NOT cover the refund books nothing until it does', async () => {
    w = await makeWorld();
    w.reportRefunded = true;
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const [cap] = await w.captureIds(a.order_id);
    w.refundNext.status = 'PENDING';
    const r1 = await request(u, 200);
    await executeRefund(w.deps, { refund_request_id: r1 });
    for (const r of w.refunds.values()) r.status = 'COMPLETED';
    // The order read still shows only 100 refunded although GET refund says 200 are completed.
    const real = w.paypal.getOrder.bind(w.paypal);
    w.paypal.getOrder = async (id, scenario?: string | null) => {
      const res = await real(id, scenario);
      if (res.kind !== 'order') return res;
      return {
        ...res,
        units: res.units.map((x) =>
          x.capture?.capture_id === cap
            ? {
                ...x,
                capture: {
                  ...x.capture,
                  refunded_minor: 100,
                  status: 'PARTIALLY_REFUNDED' as const,
                },
              }
            : x,
        ),
      } as typeof res;
    };
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await w.rows("SELECT 1 FROM ledger_entries WHERE kind = 'refund'")).toEqual([]);
    expect((await refundRows())[0]!.state).toBe('pending');
    w.paypal.getOrder = real;
    w.tick(2 * H);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows())[0]!.state).toBe('completed');
  });
});

describe('closing a refund whose outcome stayed unknown', () => {
  async function lostRefund(lands: boolean) {
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    if (lands) {
      w.refundNext.lose_response = true;
    } else {
      w.paypal.refundCapture = async () => ({ kind: 'timeout' });
    }
    const r1 = await request(u, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    w.refundNext.lose_response = false;
    return { a, u, r1 };
  }
  it('PayPal never saw it and the capture shows no refund: failed, the amount is free again', async () => {
    w = await makeWorld();
    const { a, u } = await lostRefund(false);
    w.tick(5 * H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows())[0]!.state).toBe('failed');
    expect(await alertKinds(w, a.order_id)).not.toContain('refund_unresolved');
    expect(
      (await requestRefund(w.deps, { unit_id: u, amount: null, reason: 'z', actor: OPERATOR })).ok,
    ).toBe(true);
  });
  it('the capture shows a refund of an amount: unresolved, an alert, the reservation kept', async () => {
    w = await makeWorld();
    w.reportRefunded = true;
    const { a, u } = await lostRefund(true);
    w.tick(5 * H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows())[0]!.state).toBe('unresolved');
    const alerts = await w.rows<{ detail: { excess_minor: number | null } }>(
      "SELECT detail FROM alerts WHERE kind = 'refund_unresolved'",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail.excess_minor).toBe(100);
    expect(
      (await requestRefund(w.deps, { unit_id: u, amount: usd(400), reason: 'z', actor: OPERATOR }))
        .ok,
    ).toBe(false);
    expect(await alertKinds(w, a.order_id)).toContain('refund_unresolved');
  });
  it('the capture shows REFUNDED without an amount: unresolved with the excess not proven', async () => {
    w = await makeWorld();
    const { u } = await lostRefund(true);
    w.tick(5 * H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows())[0]!.state).toBe('unresolved');
    const alerts = await w.rows<{ detail: { excess_minor: number | null } }>(
      "SELECT detail FROM alerts WHERE kind = 'refund_unresolved'",
    );
    expect(alerts[0]!.detail.excess_minor).toBeNull();
    expect(
      (await requestRefund(w.deps, { unit_id: u, amount: usd(400), reason: 'z', actor: OPERATOR }))
        .ok,
    ).toBe(false);
  });
  it('the order cannot be read after 5 h but the 24 h window runs: nothing is closed yet', async () => {
    w = await makeWorld();
    const { a } = await lostRefund(false);
    const real = w.paypal.getOrder.bind(w.paypal);
    w.paypal.getOrder = async () => ({ kind: 'timeout' }) as never;
    w.tick(5 * H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows())[0]!.state).toBe('unknown');
    expect((await ops(w, a.order_id)).find((o) => o.kind === 'refund')!.state).toBe('unknown');
    w.paypal.getOrder = real;
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });
    expect((await refundRows())[0]!.state).toBe('failed');
  });
});
