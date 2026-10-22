// MVP-B lane B-L5: gaps in the hourly 7-day re-read of paid orders. The kill switch pauses the
// re-read without losing the order; one pass is bounded by max_items; the re-read is one read per
// order per hour. Real PGlite, scripted PayPal. No change to money logic.
import { afterEach, describe, expect, it } from 'vitest';
import { nextDueAt, runDue } from './index';
import { makeWorld, orderStatus, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;

describe('re-read and the kill switch (B-L5)', () => {
  it('switch off when the hour is up: no read, the order is not lost; switch on: exactly one read', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const base = w.paypal.count('get');
    w.switches.paypal_outbound = false;
    w.tick(H + 1000);
    const paused = await runDue(w.deps, { max_items: 10 });
    expect(paused.processed).toBe(0);
    expect(w.paypal.count('get')).toBe(base);
    w.tick(2 * H); // paused for hours: the re-read is still owed
    expect((await nextDueAt(w.db)) !== null).toBe(true);
    w.switches.paypal_outbound = true;
    const resumed = await runDue(w.deps, { max_items: 10 });
    expect(resumed.processed).toBe(1);
    expect(w.paypal.count('get')).toBe(base + 1);
    // The hour restarts from the read, not from the missed slots: no burst of catch-up reads.
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(base + 1);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });

  it('a pause that outlasts the 7 days ends the watch: no read after the window, even after resume', async () => {
    w = await makeWorld();
    await paid(w);
    const base = w.paypal.count('get');
    w.switches.paypal_outbound = false;
    w.tick(7 * DAY + H);
    await runDue(w.deps, { max_items: 10 });
    w.switches.paypal_outbound = true;
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(base);
  });

  // KNOWN GAP (reported, not fixed here: nextDueAt has no clock, a fix changes its signature in
  // due.ts). A paid order whose 7 days passed with no re-read keeps a past next_at, so nextDueAt
  // returns a time in the past forever and the job loop wakes every 100 ms (no provider call, one
  // read-only query per wake). it.fails turns green-to-red when the gap is fixed.
  it.fails('nextDueAt is null once the 7 days passed unread (known gap)', async () => {
    w = await makeWorld();
    await paid(w);
    w.tick(7 * DAY + H);
    expect(await nextDueAt(w.db)).toBeNull();
  });
});

describe('re-read is bounded by max_items (B-L5)', () => {
  it('two paid orders, a budget of one: one read per pass, the other waits for the next pass', async () => {
    w = await makeWorld();
    await paid(w);
    await paid(w, { buyer_id: 'buy_B' });
    const base = w.paypal.count('get');
    w.tick(H + 1000);
    const first = await runDue(w.deps, { max_items: 1 });
    expect(first.processed).toBe(1);
    expect(w.paypal.count('get')).toBe(base + 1);
    const second = await runDue(w.deps, { max_items: 1 });
    expect(second.processed).toBe(1);
    expect(w.paypal.count('get')).toBe(base + 2);
    const third = await runDue(w.deps, { max_items: 1 });
    expect(third.processed).toBe(0);
    expect(w.paypal.count('get')).toBe(base + 2);
  });

  it('an order is read once per hour however many passes run', async () => {
    w = await makeWorld();
    await paid(w);
    const base = w.paypal.count('get');
    w.tick(H + 1000);
    for (let i = 0; i < 5; i += 1) await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(base + 1);
  });
});
