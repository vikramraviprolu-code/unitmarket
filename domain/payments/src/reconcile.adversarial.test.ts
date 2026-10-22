// Adversarial tests of lane 05b: a process killed in the middle of a capture, repeated passes, a
// webhook and a poller racing on one order, reads that lie, a provider that fails.
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileOrder, recoverOnStartup, runDue } from './index';
import {
  alertKinds,
  count,
  deadCapture,
  lostResponse,
  makeWorld,
  orderStatus,
  sentCapture,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const TERMINAL = new Set(['paid', 'paid_partial', 'failed', 'abandoned', 'frozen']);

describe('crash recovery (REL-2)', () => {
  it('kill -9 simulated between sent and response (PayPal captured): terminal within two passes', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    await recoverOnStartup(w.restart());
    await runDue(w.restart(), { max_items: 10 });
    expect(TERMINAL.has(await orderStatus(w, a.order_id))).toBe(true);
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
  it('kill -9 simulated between sent and response (PayPal never saw it): terminal within two passes, one charge', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    await recoverOnStartup(w.restart());
    await runDue(w.restart(), { max_items: 10 });
    expect(TERMINAL.has(await orderStatus(w, a.order_id))).toBe(true);
    expect([...w.paypal.orders.values()].filter((o) => o.capture !== null)).toHaveLength(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
  it('a restart in the middle of a mismatch ends frozen, not paid', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    w.paypal.tamper = { amount_delta: 5 };
    await recoverOnStartup(w.restart());
    await runDue(w.restart(), { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('frozen');
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await alertKinds(w, a.order_id)).toContain('frozen_order');
  });
});

describe('repeats and races', () => {
  it('runDue twice changes nothing the second time (REL-4)', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    const snapshot = async (): Promise<unknown> => [
      await w.rows('SELECT * FROM orders ORDER BY id'),
      await w.rows('SELECT * FROM order_units ORDER BY id'),
      await w.rows('SELECT * FROM operations ORDER BY id'),
      await w.rows('SELECT * FROM entitlements ORDER BY id'),
      await w.rows('SELECT * FROM ledger_entries ORDER BY id'),
      await w.rows('SELECT * FROM receipts ORDER BY id'),
      await w.rows('SELECT * FROM alerts ORDER BY id'),
    ];
    const before = await snapshot();
    const calls = w.paypal.calls.length;
    const again = await runDue(w.deps, { max_items: 10 });
    expect(again.processed).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(w.paypal.calls.length).toBe(calls);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('webhook and poller race on one order give one transition and one sale', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(31_000);
    const [x, y] = await Promise.all([
      reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'webhook' }),
      reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' }),
    ]);
    const unlocked = [x, y].map((r) => ('skipped' in r ? 0 : r.unlocked.length));
    expect(unlocked.reduce((s, n) => s + n, 0)).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'paypal_fee'")).toBe(1);
    expect(await count(w, 'receipts')).toBe(1);
    expect(await count(w, 'access_events', "kind = 'access_ready'")).toBe(1);
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('a poller and a runDue race on one order: one sale', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(31_000);
    await Promise.all([
      reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' }),
      runDue(w.deps, { max_items: 10 }),
      runDue(w.deps, { max_items: 10 }),
    ]);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
});

describe('a provider that misbehaves', () => {
  it('a read that comes back as garbage changes nothing and costs no charge', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.paypal.queue.get.push({ kind: 'order', provider_order_id: 'NOT-VALID' } as never);
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    expect(w.paypal.count('capture')).toBe(1);
    w.tick(10 * 60_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('a blocked read (transport stop) pauses the pass without touching the operation', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.paypal.queue.get.push({ kind: 'blocked', by: 'kill_switch' } as never);
    w.tick(31_000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.expired).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('a read whose order id differs freezes the order and sends nothing', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.paypal.tamper = { provider_order_id: 'SOMEOTHERORDER' };
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('frozen');
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries')).toBe(0);
    const before = w.paypal.calls.length;
    w.tick(60 * 60_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.calls.length).toBe(before); // a frozen order is a human's, not the poller's
  });
});
