// BU-5 adversarial tests of the due-work runner: bad budgets, a second pass racing the first, a
// read that fails after its slot was taken. payments cannot import jobs (S1), so what the loop does
// with `callBudget` (throws, NaN) is tested in packages/jobs/src/loop.budget.integration.test.ts;
// here the same hostile inputs arrive as what the loop would hand over: a bad `max_items`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderRead } from '@umsbx/contracts';
import { runDue } from './index';
import { lostResponse, makeWorld, orderStatus, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

// Worlds of six paid orders take seconds on a busy machine; the default 30 s is too tight.
vi.setConfig({ testTimeout: 120_000 });

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const gets = (id?: string): number =>
  w.paypal.calls.filter((c) => c.op === 'get' && (id === undefined || c.provider_order_id === id))
    .length;
const EMPTY = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };

async function threeDue() {
  const orders = [];
  for (const offer of ['ofr_1', 'ofr_2', 'ofr_3']) {
    orders.push(await paid(w, { buyer_id: 'buy_A', offers: [offer] }));
  }
  w.tick(H + 1000);
  return orders;
}

describe('a budget that is not a positive whole number', () => {
  it('callBudget returns negative or NaN: treated as 0 (no item, no call, no state change)', async () => {
    w = await makeWorld();
    await threeDue();
    await lostResponse(w, { buyer_id: 'buy_B' });
    w.tick(40_000);
    const calls = w.paypal.calls.length;
    for (const max_items of [0, -1, -50, Number.NaN, 2.5, Number.POSITIVE_INFINITY, '5' as never]) {
      for (const allow of [undefined, 'all', 'money_only'] as const) {
        const r = await runDue(w.deps, { max_items, ...(allow === undefined ? {} : { allow }) });
        expect(r, `${String(max_items)} ${String(allow)}`).toEqual(EMPTY);
      }
    }
    expect(w.paypal.calls.length).toBe(calls);
  });

  it('callBudget throws: no call in that pass (runDue side: a pass with no items touches nothing)', async () => {
    w = await makeWorld();
    const [a] = await threeDue();
    const lost = await lostResponse(w, { buyer_id: 'buy_B' });
    w.tick(40_000);
    const calls = w.paypal.calls.length;
    await runDue(w.deps, { max_items: 0, allow: 'money_only' });
    expect(w.paypal.calls.length).toBe(calls);
    expect(await orderStatus(w, a!.order_id)).toBe('paid');
    expect(await orderStatus(w, lost.order_id)).toBe('unresolved');
  });

  it('the outbound switch off still wins over money_only', async () => {
    w = await makeWorld();
    const lost = await lostResponse(w);
    w.tick(40_000);
    w.switches.paypal_outbound = false;
    const calls = w.paypal.calls.length;
    expect(await runDue(w.deps, { max_items: 10, allow: 'money_only' })).toEqual(EMPTY);
    expect(w.paypal.calls.length).toBe(calls);
    expect(await orderStatus(w, lost.order_id)).toBe('unresolved');
  });
});

describe('two passes at once', () => {
  it('two passes at once never read the same due order twice (no double read; the allowance is NOT shared, see the next test)', async () => {
    w = await makeWorld();
    await threeDue();
    const base = gets();
    const [x, y] = await Promise.all([
      runDue(w.deps, { max_items: 3 }),
      runDue(w.deps, { max_items: 3 }),
    ]);
    expect(x.processed + y.processed).toBe(3);
    expect(gets() - base).toBe(3); // not 6
    // and a third and fourth pass in the same hour read nothing
    await Promise.all([runDue(w.deps, { max_items: 3 }), runDue(w.deps, { max_items: 3 })]);
    expect(gets() - base).toBe(3);
  });

  it('KNOWN LIMIT: two passes with an allowance of 1 each use 2 calls in all (the allowance is per pass, not shared)', async () => {
    w = await makeWorld();
    await threeDue();
    const base = gets();
    await Promise.all([runDue(w.deps, { max_items: 1 }), runDue(w.deps, { max_items: 1 })]);
    // runDue has no shared counter: what keeps two loops inside one allowance is that there is one
    // loop per approval (docs/design/nfr.md PERF-9). The claim only stops a double read.
    expect(gets() - base).toBe(2);
  });

  it('two loops with an allowance of 1 each: no order is read by both', async () => {
    w = await makeWorld();
    const orders = await threeDue();
    const before = orders.map((o) => gets(o.provider_order_id));
    await Promise.all([runDue(w.deps, { max_items: 1 }), runDue(w.deps, { max_items: 1 })]);
    const added = orders.map((o, i) => gets(o.provider_order_id) - before[i]!);
    expect(added.sort()).toEqual([0, 1, 1]); // two different orders, one read each
  });

  it('a second pass that starts while the first is inside its read does not read that order again', async () => {
    w = await makeWorld();
    const [only] = [await paid(w)];
    w.tick(H + 1000);
    const base = gets(only.provider_order_id);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inside: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      inside = resolve;
    });
    w.paypal.beforeGet = async () => {
      w.paypal.beforeGet = null; // only the first read is held
      inside();
      await held;
    };
    const first = runDue(w.deps, { max_items: 5 });
    await entered;
    const second = await runDue(w.deps, { max_items: 5 }); // the first still waits for PayPal
    expect(second).toEqual(EMPTY);
    release();
    expect((await first).processed).toBe(1);
    expect(gets(only.provider_order_id)).toBe(base + 1);
  });

  it('a money_only pass and a full pass at once read an unknown capture once', async () => {
    w = await makeWorld();
    const lost = await lostResponse(w);
    w.tick(40_000);
    const [x, y] = await Promise.all([
      runDue(w.deps, { max_items: 5, allow: 'money_only' }),
      runDue(w.deps, { max_items: 5, allow: 'all' }),
    ]);
    expect(x.processed + y.processed).toBe(1);
    expect(await orderStatus(w, lost.order_id)).toBe('paid');
    expect(w.paypal.count('capture')).toBe(1);
  });
});

describe('a re-read that does not happen must not be lost', () => {
  it('PayPal blocks the read (gate budget, kill switch): the re-read is still owed on the next pass', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.tick(6 * H);
    const deps = { ...w.deps, config: { ...w.deps.config, reread_paid_every_ms: 6 * H } };
    const base = gets(a.provider_order_id);
    const blocked: OrderRead = { kind: 'blocked', by: 'dry_run_miss' };
    w.paypal.queue.get.push(blocked);
    const first = await runDue(deps, { max_items: 5 });
    expect(first.processed).toBe(0);
    // not postponed by 6 h: the very next pass reads it
    const second = await runDue(deps, { max_items: 5 });
    expect(second.processed).toBe(1);
    expect(gets(a.provider_order_id)).toBe(base + 2);
    // and now it is spaced again
    await runDue(deps, { max_items: 5 });
    expect(gets(a.provider_order_id)).toBe(base + 2);
  });

  it('PayPal throws in the read: the error reaches the caller and the order is not postponed', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.tick(H + 1000);
    const base = gets(a.provider_order_id);
    w.paypal.beforeGet = () => Promise.reject(new Error('boom'));
    await expect(runDue(w.deps, { max_items: 5 })).rejects.toThrow('boom');
    w.paypal.beforeGet = null;
    const r = await runDue(w.deps, { max_items: 5 });
    expect(r.processed).toBe(1);
    expect(gets(a.provider_order_id)).toBe(base + 2); // the failed attempt and the retry
  });
});
