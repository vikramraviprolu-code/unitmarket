// INT-AL AL.4: the sweep resolves an alert when its condition clears, by exact rules, once, as system on the job
// channel. One test per row of the spec table.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOUR, jobCtx, makeWorld } from './world';
import type { World } from './world';
import { alertState, autoResolve } from './index';

let w: World;
beforeEach(async () => {
  w = await makeWorld('al-auto');
});
afterEach(async () => w.close());

const sweep = async (): Promise<number> => {
  w.as(jobCtx());
  return (await autoResolve(w.deps)).resolved;
};

describe('auto-resolve (AL.4)', () => {
  it.each(['paid', 'paid_partial', 'failed', 'abandoned'])(
    'payment_unresolved and frozen_order resolve when the order is %s',
    async (status) => {
      await w.order(1, { status: 'unresolved' });
      const p = await w.alert({ kind: 'payment_unresolved', order: 1, unit: 1, reason: 'a' });
      const f = await w.alert({ kind: 'frozen_order', order: 1, unit: 1, reason: 'b' });
      expect(await sweep()).toBe(0);
      await w.raw.query('UPDATE orders SET status = $2 WHERE id = $1', ['ord_1', status]);
      expect(await sweep()).toBe(2);
      expect(await alertState(w.db, p)).toBe('resolved');
      expect(await alertState(w.db, f)).toBe('resolved');
      const ev = (await w.events(p))[0]!;
      expect(ev.kind).toBe('auto_resolved');
      expect(await w.trace('alert_events', ev.id)).toEqual([
        { actor_kind: 'system', actor_id: null, channel: 'job' },
      ]);
    },
  );

  it('resolves once: a second pass writes no new event', async () => {
    await w.order(1, { status: 'paid' });
    const p = await w.alert({ kind: 'payment_unresolved', order: 1, unit: 1, reason: 'a' });
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await w.events(p)).toHaveLength(1);
  });

  it('refund_outcome_unknown_<rq> resolves when the request is completed and its ledger row exists', async () => {
    await w.order(1, { status: 'paid' });
    await w.refundRequest({
      id: 'rfr_1',
      unit: 1,
      state: 'unresolved',
      refund_id: 'RF1',
      amount: 100,
    });
    const a = await w.alert({
      kind: 'refund_unresolved',
      order: 1,
      unit: 1,
      reason: 'refund_outcome_unknown_rfr_1',
    });
    expect(await sweep()).toBe(0);
    await w.raw.query("UPDATE refund_requests SET state = 'completed' WHERE id = 'rfr_1'");
    expect(await sweep()).toBe(0); // completed but not booked
    await w.ledgerRefund({ unit: 1, refund_id: 'RF1', amount: 100 });
    expect(await sweep()).toBe(1);
    expect(await alertState(w.db, a)).toBe('resolved');
  });

  it('refund_failed resolves when a later request for the same unit is completed with its ledger row', async () => {
    await w.order(1, { status: 'paid' });
    await w.refundRequest({ id: 'rfr_1', unit: 1, state: 'failed', refund_id: null, amount: 100 });
    const a = await w.alert({
      kind: 'refund_failed',
      order: 1,
      unit: 1,
      reason: 'refund_failed_rfr_1',
      detail: { refund_request_id: 'rfr_1' },
    });
    expect(await sweep()).toBe(0);
    w.clock.advance(HOUR);
    await w.refundRequest({
      id: 'rfr_2',
      unit: 1,
      state: 'completed',
      refund_id: 'RF2',
      amount: 100,
    });
    expect(await sweep()).toBe(0); // no ledger row yet
    await w.ledgerRefund({ unit: 1, refund_id: 'RF2', amount: 100 });
    expect(await sweep()).toBe(1);
    expect(await alertState(w.db, a)).toBe('resolved');
  });

  it.each([
    ['revoked', { revoked: true }],
    ['exhausted', { exhausted: true }],
    ['expired', { expires_at: '2026-11-05T09:00:00.000Z' }],
  ])('mandate_near_cap resolves when the mandate is %s', async (_n, over) => {
    await w.mandate({ id: 'man_1', max_total: 1000, spent: 950, ...over });
    const a = await w.alert({ kind: 'mandate_near_cap', reason: 'cap90_man_1' });
    expect(await sweep()).toBe(1);
    expect(await alertState(w.db, a)).toBe('resolved');
  });

  it('webhook_failing resolves when the latest delivery of the subscription is delivered', async () => {
    await w.subscription({ id: 'wsb_1' });
    await w.delivery({ id: 'wdl_1', sub: 'wsb_1', status: 'failed', n: 1 });
    await w.delivery({ id: 'wdl_2', sub: 'wsb_1', status: 'dead', n: 2 });
    const a = await w.alert({ kind: 'webhook_failing', reason: 'webhook_failing_wsb_1_wdl_1' });
    expect(await sweep()).toBe(0);
    await w.delivery({ id: 'wdl_3', sub: 'wsb_1', status: 'delivered', n: 3 });
    expect(await sweep()).toBe(1);
    expect(await alertState(w.db, a)).toBe('resolved');
  });
});
