// BU-9 (hotfix) regression, end to end offline: the real job loop, the real due work and a real
// in-memory database, with the scripted PayPal of the gate world. The owner's sandbox run showed a
// freshly started app reading stale checkouts (24 h waiting, PayPal order gone, HTTP 404) about once
// a second with nobody using it, nearly all not_found, against the 300-call day of D-035. The clock
// and the timers move together here, so ten minutes take no time. No network, no credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLoop } from '@umsbx/jobs';
import { BUYER_A, BUYER_B, DAY, PRICES, makeWorld, placeAndCheckout, rows } from './world';
import type { World } from './world';

const MINUTE = 60_000;
const MAX_SLEEP = 5_000; // composition's production value
const BUDGET = 300; // D-035: calls a day

let w: World;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  vi.useRealTimers();
  await w.td.db.close();
});

/** Three stale checkouts: placed, sent to PayPal, then the buyer never came back. */
async function threeStale(): Promise<string[]> {
  w = await makeWorld();
  await w.td.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
  const codes = Object.keys(PRICES).slice(0, 3);
  expect(codes).toHaveLength(3);
  const refs: string[] = [];
  for (const [i, code] of codes.entries()) {
    const o = await placeAndCheckout(w, i === 2 ? BUYER_B : BUYER_A, code);
    refs.push(o.order_ref);
  }
  w.td.clock.advance(DAY + 1000);
  return refs;
}

function runLoop() {
  const sweepWindows = () => Promise.resolve({ ended: 0 });
  return startLoop(
    { ...w.deps, environment: 'sandbox', sweepWindows },
    {
      max_sleep_ms: MAX_SLEEP,
      max_items: 100,
      recover_on_start: false,
      // the approval's own count, as composition reads it: 300 a day, every call counted
      callBudget: () =>
        Promise.resolve({
          remaining_today: BUDGET - w.paypal.calls.length,
          max_calls_per_day: BUDGET,
        }),
      gap_sleep: (ms) => {
        w.td.clock.advance(ms);
        return Promise.resolve();
      },
    },
  );
}
async function elapse(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    w.td.clock.advance(100);
    await vi.advanceTimersByTimeAsync(100);
  }
}
const gets = (): number => w.paypal.count('get');

describe('BU-9 regression: stale checkouts whose PayPal order is gone', () => {
  it('(d) N=3 stale orders, all not_found: ten simulated minutes of the loop make at most 3 get_order calls and close all three', async () => {
    const refs = await threeStale();
    w.paypal.orders.clear(); // PayPal no longer knows any of them: HTTP 404 = not_found
    const loop = runLoop();
    await vi.advanceTimersByTimeAsync(0);
    await elapse(10 * MINUTE);
    await loop.stop();

    expect(gets()).toBeLessThanOrEqual(3);
    expect(w.paypal.count('capture')).toBe(0);
    expect(w.paypal.count('create')).toBe(3); // the three creates of the setup, no others
    for (const ref of refs) {
      expect(await rows(w, 'SELECT status FROM orders WHERE order_ref = $1', [ref])).toEqual([
        { status: 'abandoned' },
      ]);
    }
    expect(await rows(w, 'SELECT DISTINCT status FROM order_units')).toEqual([
      { status: 'declined' },
    ]);
    expect(await rows(w, 'SELECT DISTINCT money_state FROM entitlements')).toEqual([
      { money_state: 'denied' },
    ]);
    expect(await rows(w, 'SELECT count(*)::int AS n FROM alerts')).toEqual([{ n: 0 }]);
  });

  it('(c) the same orders while PayPal answers unavailable (5xx) all the time: kept, and read at the slow rhythm, never every 100 ms', async () => {
    const refs = await threeStale();
    w.paypal.readsUnavailable = true;
    const loop = runLoop();
    await vi.advanceTimersByTimeAsync(0);
    await elapse(MINUTE);
    // a pass reads each of the 3 orders once; passes are max_sleep_ms apart
    expect(gets()).toBeLessThanOrEqual(3 * (MINUTE / MAX_SLEEP + 1));
    await elapse(9 * MINUTE);
    await loop.stop();

    expect(w.paypal.count('capture')).toBe(0);
    for (const ref of refs) {
      expect(await rows(w, 'SELECT status FROM orders WHERE order_ref = $1', [ref])).toEqual([
        { status: 'awaiting_buyer' },
      ]);
    }
    expect(await rows(w, 'SELECT DISTINCT status FROM order_units')).toEqual([
      { status: 'expected' },
    ]);
    // the polling line holds (150 of 300): what a buyer's capture needs is never spent on polling
    expect(BUDGET - w.paypal.calls.length).toBeGreaterThanOrEqual(150);
  });

  it('(f) an order PayPal still knows is not touched by the new rule: unapproved, it is abandoned by the old rule after one read', async () => {
    const refs = await threeStale();
    w.paypal.orders.delete([...w.paypal.orders.keys()][0]!); // only one is gone
    const loop = runLoop();
    await vi.advanceTimersByTimeAsync(0);
    await elapse(MINUTE);
    await loop.stop();
    expect(gets()).toBe(3); // one read each, then nothing is left to read
    for (const ref of refs) {
      expect(await rows(w, 'SELECT status FROM orders WHERE order_ref = $1', [ref])).toEqual([
        { status: 'abandoned' },
      ]);
    }
  });
});
