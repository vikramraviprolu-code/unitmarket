// INT-AL AL.4 negative cases (F3, F8): a condition that has not cleared does not resolve, and the alerts that
// need a human never resolve by themselves, even when the request they name is completed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeAlert, alertState, autoResolve, resolveAlert } from './index';
import { ctxOf, jobCtx, makeWorld } from './world';
import type { World } from './world';

let w: World;
beforeEach(async () => {
  w = await makeWorld('al-auto-adv');
  await w.order(1, { status: 'paid' });
});
afterEach(async () => w.close());
const sweep = async (): Promise<number> => {
  w.as(jobCtx());
  return (await autoResolve(w.deps)).resolved;
};

describe('auto-resolve negatives (AL.4)', () => {
  it.each(['cannot_book_RF1', 'ledger_rule_RF1'])(
    'a refund_unresolved %s alert on a completed request with its ledger row is NOT auto-resolved',
    async (reason) => {
      await w.refundRequest({ id: 'rfr_1', unit: 1, state: 'completed', refund_id: 'RF1', amount: 100 });
      await w.ledgerRefund({ unit: 1, refund_id: 'RF1', amount: 100 });
      const a = await w.alert({ kind: 'refund_unresolved', order: 1, unit: 1, reason });
      expect(await sweep()).toBe(0);
      expect(await alertState(w.db, a)).toBe('open');
      expect(await w.events(a)).toHaveLength(0);
    },
  );

  it('refund_unbooked is manual only', async () => {
    await w.refundRequest({ id: 'rfr_1', unit: 1, state: 'completed', refund_id: 'RF1', amount: 100 });
    await w.ledgerRefund({ unit: 1, refund_id: 'RF1', amount: 100 });
    const a = await w.alert({ kind: 'refund_unbooked', order: 1, unit: 1, reason: 'over_refund_remote_rfr_1' });
    expect(await sweep()).toBe(0);
    expect(await alertState(w.db, a)).toBe('open');
  });

  it('refund_outcome_unknown_<rq> without its ledger row stays open, even when another request is booked', async () => {
    await w.refundRequest({ id: 'rfr_1', unit: 1, state: 'completed', refund_id: 'RF1', amount: 100 });
    await w.refundRequest({ id: 'rfr_2', unit: 1, state: 'completed', refund_id: 'RF2', amount: 100 });
    await w.ledgerRefund({ unit: 1, refund_id: 'RF2', amount: 100 });
    const a = await w.alert({ kind: 'refund_unresolved', order: 1, unit: 1, reason: 'refund_outcome_unknown_rfr_1' });
    expect(await sweep()).toBe(0);
    expect(await alertState(w.db, a)).toBe('open');
  });

  it('every other kind is manual only, whatever the order status', async () => {
    const kinds = ['create_rejected', 'content_unavailable', 'unexpected_capture', 'fee_above_amount', 'reversal', 'reversal_hint', 'partial_composite'];
    const ids: string[] = [];
    for (const k of kinds) ids.push(await w.alert({ kind: k, order: 1, unit: 1, reason: `m_${k}` }));
    expect(await sweep()).toBe(0);
    for (const id of ids) expect(await alertState(w.db, id)).toBe('open');
  });

  it('an active mandate and a webhook whose latest delivery failed stay open', async () => {
    await w.mandate({ id: 'man_1', max_total: 1000, spent: 950 });
    await w.subscription({ id: 'wsb_1' });
    await w.delivery({ id: 'wdl_1', sub: 'wsb_1', status: 'delivered', n: 1 });
    await w.delivery({ id: 'wdl_2', sub: 'wsb_1', status: 'failed', n: 2 });
    const m = await w.alert({ kind: 'mandate_near_cap', reason: 'cap90_man_1' });
    const h = await w.alert({ kind: 'webhook_failing', reason: 'webhook_failing_wsb_1_wdl_1' });
    expect(await sweep()).toBe(0);
    expect(await alertState(w.db, m)).toBe('open');
    expect(await alertState(w.db, h)).toBe('open');
  });

  it('a payment_unresolved alert on an order that is still unresolved stays open', async () => {
    await w.order(2, { status: 'unresolved' });
    const a = await w.alert({ kind: 'payment_unresolved', order: 2, unit: 2, reason: 'x' });
    expect(await sweep()).toBe(0);
    expect(await alertState(w.db, a)).toBe('open');
  });

  it('an alert an operator already resolved is not resolved again, and an acknowledged one still is', async () => {
    const a = await w.alert({ kind: 'payment_unresolved', order: 1, unit: 1, reason: 'a' });
    const b = await w.alert({ kind: 'frozen_order', order: 1, unit: 1, reason: 'b' });
    w.as(ctxOf());
    await resolveAlert(w.deps, { alert_id: a, reason_code: 'fixed_upstream' });
    await acknowledgeAlert(w.deps, { alert_id: b });
    expect(await sweep()).toBe(1);
    expect((await w.events(a)).map((e) => e.kind)).toEqual(['resolved']);
    expect((await w.events(b)).map((e) => e.kind)).toEqual(['acknowledged', 'auto_resolved']);
  });
});
