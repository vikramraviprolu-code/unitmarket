// DP-2b (MVP-D): startup recovery selects by the state of the PayPal order, not by the order status.
// Real PGlite, scripted PayPal. A pack is the approval of ofr_1 and ofr_3: two PayPal orders.
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkInvariants,
  executeRefund,
  onBuyerReturn,
  recoverOnStartup,
  requestRefund,
} from './index';
import { BUYER_A, OPERATOR, approved, makeWorld, paid, providerOrdersOf } from './ops/support';
import type { PaymentsDeps } from '@umsbx/contracts';
import type { Awaiting, OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const AGAIN = 'https://www.sandbox.paypal.com/checkoutnow?token=PO2AGAIN';
const ret = (ref: string) => onBuyerReturn(w.deps, { order_ref: ref, actor: BUYER_A });
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);
const states = async (order_id: string): Promise<string[]> =>
  (await providerOrdersOf(w, order_id)).map((p) => p.state);
const orderStatus = async (id: string) =>
  (await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id]))[0]!.status;
const opsOf = (order_id: string, kind: string) =>
  w.rows<{ request_id: string; state: string; first_sent_at: unknown }>(
    `SELECT o.request_id, o.state, o.first_sent_at FROM operations o
       LEFT JOIN provider_orders p ON p.id = o.provider_order_ref
      WHERE o.order_id = $1 AND o.kind = $2 ORDER BY p.position, o.created_at, o.id`,
    [order_id, kind],
  );

describe('recoverOnStartup with a pack', () => {
  it('a never-sent prepared PO2 capture is not marked unknown', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    // the kill switch stops PO2's capture after PO1 captured: prepared, never sent
    w.paypal.queue.capture.push('real', { kind: 'blocked', by: 'kill_switch' });
    await ret(a.order_ref);
    expect(
      (await opsOf(a.order_id, 'capture')).map((o) => [o.state, o.first_sent_at === null]),
    ).toEqual([
      ['confirmed', false],
      ['prepared', true],
    ]);
    expect(await orderStatus(a.order_id)).toBe('capture_requested');
    w.switches.paypal_outbound = false; // recovery marks operations without a switch; the pass waits
    w.tick(61_000);
    const calls = w.paypal.calls.length;
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(0);
    expect((await opsOf(a.order_id, 'capture')).map((o) => o.state)).toEqual([
      'confirmed',
      'prepared',
    ]);
    expect(w.paypal.calls.length).toBe(calls);
    // the switch is back: the continuation sends PO2's capture once, nothing is stuck unknown
    w.switches.paypal_outbound = true;
    const again = await recoverOnStartup(w.restart());
    expect(again.resumed).toBe(0);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await opsOf(a.order_id, 'capture')).map((o) => o.state)).toEqual([
      'confirmed',
      'confirmed',
    ]);
    expect(await orderStatus(a.order_id)).toBe('paid');
    expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);
  });

  it('a reopened PO2 capture (prepared, send timestamp) is not marked unknown', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', {
      kind: 'payer_action',
      redirect_url: AGAIN,
      debug_id: 'D',
    });
    await ret(a.order_ref);
    const [, po2] = await opsOf(a.order_id, 'capture');
    expect(po2).toMatchObject({ state: 'prepared' });
    expect(po2!.first_sent_at).not.toBeNull(); // reopened: it carries the send timestamp
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    w.switches.paypal_outbound = false;
    w.tick(61_000);
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(0);
    expect((await opsOf(a.order_id, 'capture')).map((o) => o.state)).toEqual([
      'confirmed',
      'prepared',
    ]);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    expect(await orderStatus(a.order_id)).toBe('capture_requested');
    // later the continuation tries again with the next key, and the pack finishes
    w.switches.paypal_outbound = true;
    await recoverOnStartup(w.restart());
    expect(w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p1`,
      `umsK-${a.order_ref}-p2`,
      `umsK-${a.order_ref}-p2-2`,
    ]);
    expect(await orderStatus(a.order_id)).toBe('paid');
  });

  it('a sent PO2 capture is read first', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const base = w.paypal.count('get');
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        w.faults.dieBeforeCapture = true;
      }
    };
    await expect(ret(a.order_ref)).rejects.toThrow('died before the capture');
    w.faults.dieBeforeCapture = false;
    expect((await opsOf(a.order_id, 'capture')).map((o) => o.state)).toEqual(['confirmed', 'sent']);
    w.tick(61_000); // the lease of the process that died is over
    const before = w.paypal.calls.length;
    const r = await recoverOnStartup(w.restart());
    expect(r.resumed).toBe(1);
    const after = w.paypal.calls.slice(before);
    expect(after[0]).toMatchObject({ op: 'get', provider_order_id: poIds(a)[1] }); // read first
    expect(after.filter((c) => c.op === 'capture').map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p2`, // the same key, once
    ]);
    expect(await orderStatus(a.order_id)).toBe('paid');
  });

  it('an in-flight PO2 that nobody polls gets its own read-back operation, PO1 keeps its own', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'timeout' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    const po2 = (await providerOrdersOf(w, a.order_id))[1]!;
    await w.rows(
      `UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL
        WHERE order_id = $1 AND state IN ('unknown', 'sent')`,
      [a.order_id],
    );
    await w.rows(
      "DELETE FROM operations WHERE order_id = $1 AND kind = 'readback' AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 2)",
      [a.order_id],
    );
    expect((await checkInvariants(w.db)).find((i) => i.id === 'INV5')!.ok).toBe(false);
    const po1Readback = (await opsOf(a.order_id, 'readback'))[0]!;
    w.switches.paypal_outbound = false; // repair only; the pass waits
    const r = await recoverOnStartup(w.restart());
    expect(r.repaired).toBe(1);
    const readbacks = await opsOf(a.order_id, 'readback');
    expect(readbacks.map((o) => [o.request_id, o.state])).toEqual([
      [po1Readback.request_id, po1Readback.state], // PO1's is not touched
      [`umsB-${a.order_ref}-p2`, 'unknown'],
    ]);
    expect(po2.po_ref).toBe(`${a.order_ref}-p2`);
    expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);
  });

  it('a PayPal order that moved on between the list and the lock is not repaired', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'timeout' });
    await ret(a.order_ref);
    await w.rows(
      "UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL WHERE order_id = $1 AND state IN ('unknown', 'sent')",
      [a.order_id],
    );
    await w.rows(
      "DELETE FROM operations WHERE order_id = $1 AND kind = 'readback' AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 2)",
      [a.order_id],
    );
    let moved = false;
    const d2: PaymentsDeps = {
      ...w.restart(),
      db: {
        ...w.deps.db,
        query: async (sql: string, params?: unknown[]) => {
          const r = await w.deps.db.query(sql, params);
          if (!moved && sql.includes('FROM provider_orders po')) {
            moved = true;
            await w.rows(
              "UPDATE provider_orders SET state = 'declined' WHERE order_id = $1 AND position = 2",
              [a.order_id],
            );
          }
          return r;
        },
      } as PaymentsDeps['db'],
    };
    w.switches.paypal_outbound = false; // repair only
    const r = await recoverOnStartup(d2);
    expect(moved).toBe(true);
    expect(r.repaired).toBe(0);
    expect(await opsOf(a.order_id, 'readback')).toHaveLength(1); // PO1's only
  });

  it('a pending refund that nobody polls gets its read-back operation back and is counted as repaired', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!.id;
    const r1 = await requestRefund(w.deps, {
      unit_id: unit,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r1.ok) throw new Error('request refused');
    w.refundNext.status = 'PENDING';
    await executeRefund(w.deps, { refund_request_id: r1.value.refund_request_id });
    await w.rows(
      "UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL WHERE order_id = $1 AND kind IN ('refund', 'refund_readback') AND state IN ('sent', 'unknown')",
      [a.order_id],
    );
    w.switches.paypal_outbound = false;
    const r = await recoverOnStartup(w.restart());
    expect(r.repaired).toBe(1);
    expect(
      await w.rows(
        "SELECT state FROM operations WHERE order_id = $1 AND kind = 'refund_readback' ORDER BY created_at",
        [a.order_id],
      ),
    ).toEqual([{ state: 'unknown' }]);
  });
});
