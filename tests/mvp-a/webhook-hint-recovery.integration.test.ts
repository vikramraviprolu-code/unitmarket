// CO-2c (R1): a PAYMENT.CAPTURE.REVERSED webhook is a hint (ASM-63). It raises an alert for ops, but
// recovery opens no case and the buyer sees no message from it. Only read evidence does. Offline.
import { handleWebhook, runDue } from '@umsbx/payments';
import { applyAutomaticRules, listCasesForBuyer } from '@umsbx/recovery';
import { describe, expect, it } from 'vitest';
import { BUYER_A, HOUR, buy, makeWorld, one, rows } from './world';
import type { World } from './world';

const count = async (w: World, sql: string): Promise<number> =>
  Number((await one<{ c: string | number }>(w, sql)).c);

async function paidWorld() {
  const w = await makeWorld();
  const bought = await buy(w, BUYER_A, 'tide-tables');
  const unit = await one<{ id: string; capture_id: string; status: string }>(
    w,
    'SELECT id, capture_id, status FROM order_units LIMIT 1',
  );
  return {
    w,
    unit,
    order_id: (await one<{ id: string }>(w, 'SELECT id FROM orders LIMIT 1')).id,
    bought,
  };
}
const reversed = (capture_id: string, n: number) => ({
  verdict: {
    kind: 'verified' as const,
    event: {
      event_id: `WH-HINT-${n}`,
      transmission_id: `tx-hint-${n}`,
      type: 'PAYMENT.CAPTURE.REVERSED' as const,
      provider_order_id: null,
      capture_id,
      refund_id: null,
      occurred_at: '2026-10-22T10:00:00.000Z',
    },
  },
  transmission_id: `tx-hint-${n}`,
  received_at: '2026-10-22T10:00:01.000Z',
});

describe('R1: the REVERSED hint opens no recovery case', () => {
  it('after the webhook and the automatic rules: one reversal_hint alert, no case, no buyer message', async () => {
    const { w, unit } = await paidWorld();
    expect(unit.status).toBe('captured_verified');
    expect(await handleWebhook(w.td, reversed(unit.capture_id, 1))).toEqual({
      http: 200,
      outcome: 'enqueued',
    });
    expect(await count(w, "SELECT count(*) AS c FROM alerts WHERE kind = 'reversal_hint'")).toBe(1);
    expect(await count(w, "SELECT count(*) AS c FROM alerts WHERE kind = 'reversal'")).toBe(0);
    const ran = await applyAutomaticRules(w.td, { max_items: 20 });
    expect(ran.opened).toBe(0);
    expect(await count(w, 'SELECT count(*) AS c FROM recovery_cases')).toBe(0);
    expect(await listCasesForBuyer(w.td.db, { buyer_id: BUYER_A.buyer_id })).toEqual([]);
  });

  it('once a read shows the capture as declined, the reversal alert opens the case', async () => {
    const { w, unit } = await paidWorld();
    await handleWebhook(w.td, reversed(unit.capture_id, 2));
    await applyAutomaticRules(w.td, { max_items: 20 });
    expect(await count(w, 'SELECT count(*) AS c FROM recovery_cases')).toBe(0);

    await w.td.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
    for (const o of w.paypal.orders.values()) if (o.capture !== null) o.capture.status = 'DECLINED';
    w.td.clock.advance(HOUR);
    await runDue(w.deps, { max_items: 10 });
    expect(
      (await one<{ status: string }>(w, 'SELECT status FROM order_units LIMIT 1')).status,
    ).toBe('reversal_suspected');
    expect(await count(w, "SELECT count(*) AS c FROM alerts WHERE kind = 'reversal'")).toBe(1);
    const ran = await applyAutomaticRules(w.td, { max_items: 20 });
    expect(ran.opened).toBe(1);
    const cases = await rows<{ kind: string; state: string }>(
      w,
      'SELECT kind, state FROM recovery_cases',
    );
    expect(cases).toEqual([{ kind: 'reversal', state: 'open' }]);
    expect(await listCasesForBuyer(w.td.db, { buyer_id: BUYER_A.buyer_id })).toHaveLength(1);
  });
});
