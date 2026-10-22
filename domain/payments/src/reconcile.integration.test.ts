// Performance gate PERF-9 (lane 05b): 500 open operations against the scripted provider. One pass
// stays inside its call budget (at most 2 calls per second over a 60 s pass) and its time, and a few
// passes drain the queue. Real PGlite, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { beginCheckout, runDue } from './index';
import { count, makeWorld, place } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
// No wall clock is read here: the pass races a 60 s timer.
const withinMs = <T>(ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`took longer than ${ms} ms`)), ms);
    }),
  ]);

describe('PERF-9', () => {
  it('500 open operations, fixture provider: one pass under 60 s and at most 2 calls per second', async () => {
    w = await makeWorld();
    const N = 500;
    w.paypal.queue.create.push(...Array.from({ length: N }, () => ({ kind: 'timeout' as const })));
    for (let k = 0; k < N; k += 1) {
      const buyer_id = `buy_P${k}`;
      await w.insert('buyers', {
        id: buyer_id,
        display_name: 'P',
        auth_subject: `sub-p${k}`,
        country: 'US',
      });
      const p = await place(w, { buyer_id });
      await beginCheckout(w.deps, { order_id: p.order_id, actor: { kind: 'buyer', buyer_id } });
    }
    expect(await count(w, 'operations', "state = 'unknown'")).toBe(N);
    w.tick(31_000);
    const callsBefore = w.paypal.calls.length;
    const r = await withinMs(60_000, runDue(w.deps, { max_items: 100 }));
    expect(r.processed).toBe(100);
    const calls = w.paypal.calls.length - callsBefore;
    expect(calls).toBeLessThanOrEqual(120); // 2 calls per second over a 60 s pass
    for (let k = 0; k < 4; k += 1) await runDue(w.deps, { max_items: 100 });
    expect(await count(w, 'operations', "state = 'unknown'")).toBe(0);
    expect(await count(w, 'orders', "status = 'awaiting_buyer'")).toBe(N);
    expect(w.paypal.orders.size).toBe(N);
  }, 600_000);
});
