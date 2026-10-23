// BU-5 state tests of the due-work runner: the 6 h paid re-read of sandbox mode, the `money_only`
// pass that runs when the polling allowance is spent, and the order of work inside one pass.
// Real PGlite, scripted PayPal, fake clock. No change to money rules is tested here: the existing
// due tests still stand.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps } from '@umsbx/contracts';
import { beginCheckout, executeRefund, nextDueAt, requestRefund, runDue } from './index';
import {
  OPERATOR,
  alertKinds,
  approved,
  awaiting,
  deadCapture,
  lostResponse,
  makeWorld,
  opOf,
  orderStatus,
  paid,
  place,
} from './ops/support';
import type { OpsWorld } from './ops/support';

// Worlds of six paid orders take seconds on a busy machine; the default 30 s is too tight.
vi.setConfig({ testTimeout: 120_000 });

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;
const SIX_H = 6 * H;

/** The same world with the sandbox cadence of paid re-reads. */
const sandbox = (): PaymentsDeps => ({
  ...w.deps,
  config: { ...w.deps.config, reread_paid_every_ms: SIX_H },
});
const gets = (provider_order_id?: string): number =>
  w.paypal.calls.filter(
    (c) =>
      c.op === 'get' &&
      (provider_order_id === undefined || c.provider_order_id === provider_order_id),
  ).length;

/** Six paid orders: three offers, two buyers (one article cannot be bought twice by a buyer). */
async function sixPaid() {
  const orders = [];
  for (const buyer_id of ['buy_A', 'buy_B']) {
    for (const offer of ['ofr_1', 'ofr_2', 'ofr_3']) {
      orders.push(await paid(w, { buyer_id, offers: [offer] }));
    }
  }
  return orders;
}

describe('sandbox cadence: paid orders are re-read every 6 h (ASM-52)', () => {
  it('6 paid orders over a simulated sandbox day: re-reads use at most 150 calls and each order is read every 6 h', async () => {
    w = await makeWorld();
    const orders = await sixPaid();
    const deps = sandbox();
    const base = w.paypal.calls.length;
    const seenAt = new Map<string, number[]>(orders.map((o) => [o.provider_order_id, []]));
    let cursor = base;
    const t0 = deps.clock.now().getTime();
    for (let step = 1; step <= 24; step += 1) {
      // 24 h in hourly steps (the loop wakes more often; the cadence is what is under test)
      w.tick(H);
      await runDue(deps, { max_items: 100 });
      for (const c of w.paypal.calls.slice(cursor)) {
        if (c.op === 'get' && c.provider_order_id !== null) {
          seenAt.get(c.provider_order_id)?.push(deps.clock.now().getTime() - t0);
        }
      }
      cursor = w.paypal.calls.length;
    }
    const used = w.paypal.calls.length - base;
    expect(used).toBeLessThanOrEqual(150);
    expect(used).toBe(24); // 6 orders x reads at 6, 12, 18 and 24 h
    for (const [id, times] of seenAt) {
      expect(times, id).toEqual([SIX_H, 2 * SIX_H, 3 * SIX_H, 4 * SIX_H]);
    }
    // the hourly cadence of dry-run mode would have used six times as many reads
    expect(used).toBeLessThan(144);
  });

  it('no read at 5 h 59 min; one read at 6 h; the next one a full 6 h after that read', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const deps = sandbox();
    const base = gets(a.provider_order_id);
    w.tick(SIX_H - 60_000);
    await runDue(deps, { max_items: 10 });
    expect(gets(a.provider_order_id)).toBe(base);
    w.tick(60_000);
    expect((await runDue(deps, { max_items: 10 })).processed).toBe(1);
    expect(gets(a.provider_order_id)).toBe(base + 1);
    w.tick(SIX_H - 60_000);
    await runDue(deps, { max_items: 10 });
    expect(gets(a.provider_order_id)).toBe(base + 1);
    w.tick(60_000);
    await runDue(deps, { max_items: 10 });
    expect(gets(a.provider_order_id)).toBe(base + 2);
  });

  it('nextDueAt follows the configured cadence', async () => {
    w = await makeWorld();
    await paid(w);
    const verified = w.deps.clock.now().getTime();
    expect(await nextDueAt(w.db, { abandoned_checkout_ms: DAY, reread_paid_every_ms: SIX_H })).toBe(
      new Date(verified + SIX_H).toISOString(),
    );
    expect(await nextDueAt(w.db, { abandoned_checkout_ms: DAY })).toBe(
      new Date(verified + H).toISOString(),
    );
    expect(await nextDueAt(w.db)).toBe(new Date(verified + H).toISOString());
  });

  it('the 7 day watch still ends after 7 days with the 6 h cadence', async () => {
    w = await makeWorld();
    await paid(w);
    const deps = sandbox();
    const base = gets();
    w.tick(7 * DAY - H);
    await runDue(deps, { max_items: 10 });
    expect(gets()).toBe(base + 1);
    w.tick(2 * SIX_H);
    await runDue(deps, { max_items: 10 });
    expect(gets()).toBe(base + 1);
  });

  it('a nonsense or out-of-range cadence (0, negative, NaN, fractional, text, above 24 h, 7 days, 1e12, MAX_SAFE_INTEGER) falls back to hourly, it never ends the re-reads', async () => {
    for (const bad of [
      0,
      -5,
      Number.NaN,
      1.5,
      '1; DROP TABLE orders',
      Number.POSITIVE_INFINITY,
      86_400_001, // above 24 h
      7 * DAY,
      1e12,
      Number.MAX_SAFE_INTEGER,
    ]) {
      w = await makeWorld();
      const a = await paid(w);
      const deps = {
        ...w.deps,
        config: { ...w.deps.config, reread_paid_every_ms: bad as never },
      };
      const base = gets(a.provider_order_id);
      w.tick(H - 1000);
      await runDue(deps, { max_items: 10 });
      expect(gets(a.provider_order_id), String(bad)).toBe(base);
      w.tick(2000);
      await runDue(deps, { max_items: 10 });
      expect(gets(a.provider_order_id), String(bad)).toBe(base + 1);
      expect(
        await nextDueAt(w.db, { abandoned_checkout_ms: DAY, reread_paid_every_ms: bad as never }),
      ).toBe(new Date(w.deps.clock.now().getTime() + H).toISOString());
      await w.close();
    }
    w = await makeWorld(); // for afterEach
  }, 300_000);

  it('dry-run cadence stays hourly and existing due tests pass unchanged', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const explicit = {
      ...w.deps,
      config: { ...w.deps.config, reread_paid_every_ms: H },
    };
    const base = gets(a.provider_order_id);
    w.tick(H + 1000);
    // no `allow`, `allow: 'all'` and a config that says 3 600 000 all mean the same thing
    expect((await runDue(w.deps, { max_items: 10 })).processed).toBe(1);
    expect(gets(a.provider_order_id)).toBe(base + 1);
    w.tick(H);
    expect((await runDue(explicit, { max_items: 10, allow: 'all' })).processed).toBe(1);
    expect(gets(a.provider_order_id)).toBe(base + 2);
    w.tick(H);
    expect((await runDue(w.deps, { max_items: 10, allow: 'all' })).processed).toBe(1);
    expect(gets(a.provider_order_id)).toBe(base + 3);
  });
});

describe('the allowance bounds paid re-reads', () => {
  it('three re-reads due, max_items 2: two are read, the third waits for the next pass', async () => {
    w = await makeWorld();
    const orders = [];
    for (const offer of ['ofr_1', 'ofr_2', 'ofr_3']) {
      orders.push(await paid(w, { buyer_id: 'buy_A', offers: [offer] }));
    }
    w.tick(H + 1000);
    const base = gets();
    expect((await runDue(w.deps, { max_items: 2, allow: 'all' })).processed).toBe(2);
    expect(gets() - base).toBe(2);
    expect((await runDue(w.deps, { max_items: 2, allow: 'all' })).processed).toBe(1);
    expect(gets() - base).toBe(3);
    expect((await runDue(w.deps, { max_items: 2, allow: 'all' })).processed).toBe(0);
  });
});

/**
 * One paid order with an unknown refund on it, one unknown create, one unknown capture that
 * resolves, and one checkout nobody finished.
 */
async function mixed() {
  w = await makeWorld();
  const refunded = await paid(w);
  const unit = (
    await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [
      refunded.order_id,
    ])
  )[0]!;
  w.refundNext.lose_response = true;
  const asked = await requestRefund(w.deps, {
    unit_id: unit.id,
    amount: { currency: 'USD', minor: 100 },
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!asked.ok) throw new Error('refund not requested');
  await executeRefund(w.deps, { refund_request_id: asked.value.refund_request_id });
  w.refundNext.lose_response = false;
  const created = await place(w, { buyer_id: 'buy_B', offers: ['ofr_1'] });
  w.faults.loseCreateResponse = true;
  await beginCheckout(w.deps, {
    order_id: created.order_id,
    actor: { kind: 'buyer', buyer_id: 'buy_B' },
  });
  w.faults.loseCreateResponse = false;
  const lost = await lostResponse(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
  const waiting = await awaiting(w, { buyer_id: 'buy_A', offers: ['ofr_3'] });
  expect((await opOf(w, created.order_id, 'create')).state).toBe('unknown');
  return {
    refunded,
    created,
    lost,
    waiting,
    refundCalls: w.refundCalls.length,
    getRefunds: w.getRefundCalls.length,
    creates: w.paypal.count('create'),
    refundedGets: gets(refunded.provider_order_id),
  };
}

describe('allow: money_only (the polling allowance is spent)', () => {
  it('remaining at the reserve: re-reads skipped, an unknown capture is still read', async () => {
    w = await makeWorld();
    const watcher = await paid(w);
    const lost = await lostResponse(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    w.tick(H + 1000); // the capture poll (30 s) and the paid re-read (1 h) are both due
    const before = gets(watcher.provider_order_id);
    const r = await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect(r.processed).toBe(1);
    expect(await orderStatus(w, lost.order_id)).toBe('paid'); // the unknown capture was read
    expect(gets(lost.provider_order_id)).toBeGreaterThan(1);
    expect(gets(watcher.provider_order_id)).toBe(before); // the re-read waits
    // the re-read is still owed: the next full pass reads it
    const full = await runDue(w.deps, { max_items: 10, allow: 'all' });
    expect(full.processed).toBeGreaterThanOrEqual(1);
    expect(gets(watcher.provider_order_id)).toBe(before + 1);
  });

  it('money_only pass touches no create, refund, abandonment or re-read work', async () => {
    const m = await mixed();
    w.tick(H + 1000);
    const r = await runDue(w.deps, { max_items: 20, allow: 'money_only' });
    expect(r).toEqual({ processed: 1, still_unknown: 0, expired: 0, abandoned: 0 });
    expect(await orderStatus(w, m.lost.order_id)).toBe('paid');
    expect(w.paypal.count('create')).toBe(m.creates);
    expect((await opOf(w, m.created.order_id, 'create')).state).toBe('unknown');
    expect(w.refundCalls.length).toBe(m.refundCalls);
    expect(w.getRefundCalls.length).toBe(m.getRefunds);
    expect(gets(m.refunded.provider_order_id)).toBe(m.refundedGets);
    expect(await orderStatus(w, m.waiting.order_id)).toBe('awaiting_buyer');
  });

  it('F5: a day later money_only closes what needs no resend (create past its 5 h key, refund past its 24 h window) and still does no abandonment or re-read', async () => {
    const m = await mixed();
    w.tick(H + 1000);
    await runDue(w.deps, { max_items: 20, allow: 'money_only' });
    w.tick(DAY);
    const late = await runDue(w.deps, { max_items: 20, allow: 'money_only' });
    expect(late.abandoned).toBe(0);
    expect(await orderStatus(w, m.waiting.order_id)).toBe('awaiting_buyer');
    // the create is closed with an alert and no resend
    expect(w.paypal.count('create')).toBe(m.creates);
    const create = await opOf(w, m.created.order_id, 'create');
    expect(create.state).toBe('failed');
    expect(await orderStatus(w, m.created.order_id)).not.toBe('created');
    expect(await alertKinds(w, m.created.order_id)).toContain('payment_unresolved');
    // the refund is closed after one read of the order, never sent again
    const refund = await opOf(w, m.refunded.order_id, 'refund');
    expect(refund.state).toBe('failed');
    expect(w.refundCalls.length).toBe(m.refundCalls);
    expect(gets(m.refunded.provider_order_id)).toBe(m.refundedGets + 1); // the close read, no re-read
    // control: the abandonment and the re-read were only waiting for an 'all' pass
    const all = await runDue(w.deps, { max_items: 20, allow: 'all' });
    expect(all.abandoned).toBe(1);
    expect(await orderStatus(w, m.waiting.order_id)).toBe('abandoned');
  });

  it('F5: an unknown create or refund that is not yet past its window is left alone by money_only', async () => {
    const m = await mixed();
    w.tick(4 * H); // inside the 5 h key and the 24 h window
    await runDue(w.deps, { max_items: 20, allow: 'money_only' });
    expect((await opOf(w, m.created.order_id, 'create')).state).toBe('unknown');
    expect((await opOf(w, m.refunded.order_id, 'refund')).state).toBe('unknown');
    expect(w.paypal.count('create')).toBe(m.creates);
    expect(w.refundCalls.length).toBe(m.refundCalls);
    expect(w.getRefundCalls.length).toBe(m.getRefunds);
  });

  it('F5: money_only sweeps a stale sent operation of every kind into unknown (no call)', async () => {
    w = await makeWorld();
    const sentCreate = await place(w);
    await w.db.query(
      "UPDATE operations SET state = 'sent', lease_until = $2 WHERE order_id = $1 AND kind = 'create'",
      [sentCreate.order_id, new Date(w.deps.clock.now().getTime() + 1000).toISOString()],
    );
    w.tick(120_000); // the lease ran out
    const calls = w.paypal.calls.length;
    await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect((await opOf(w, sentCreate.order_id, 'create')).state).toBe('unknown');
    expect(w.paypal.calls.length).toBe(calls); // swept, not resent
    await runDue(w.deps, { max_items: 10, allow: 'all' });
    expect((await opOf(w, sentCreate.order_id, 'create')).state).toBe('confirmed');
  });

  it('an allow value nobody knows is read as money_only (fail closed)', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.tick(H + 1000);
    const base = gets(a.provider_order_id);
    await runDue(w.deps, { max_items: 10, allow: 'everything' as never });
    expect(gets(a.provider_order_id)).toBe(base);
  });

  it('max_items still bounds a money_only pass', async () => {
    w = await makeWorld();
    const first = await lostResponse(w);
    w.tick(10_000);
    const second = await lostResponse(w, { buyer_id: 'buy_B' });
    w.tick(40_000);
    const r = await runDue(w.deps, { max_items: 1, allow: 'money_only' });
    expect(r.processed).toBe(1);
    expect(await orderStatus(w, first.order_id)).toBe('paid');
    expect(await orderStatus(w, second.order_id)).toBe('unresolved');
  });
});

describe('priority inside one pass', () => {
  it('capture and read-back unknowns come before creates, creates before refunds, re-reads last', async () => {
    w = await makeWorld();
    // refund unknown first (earliest next_retry_at), then a create, then a capture
    const owner = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [
        owner.order_id,
      ])
    )[0]!;
    w.refundNext.lose_response = true;
    const asked = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!asked.ok) throw new Error('refund not requested');
    await executeRefund(w.deps, { refund_request_id: asked.value.refund_request_id });
    w.refundNext.lose_response = false;
    w.tick(5_000);
    const created = await place(w, { buyer_id: 'buy_B', offers: ['ofr_1'] });
    w.faults.loseCreateResponse = true;
    await beginCheckout(w.deps, {
      order_id: created.order_id,
      actor: { kind: 'buyer', buyer_id: 'buy_B' },
    });
    w.faults.loseCreateResponse = false;
    w.tick(5_000);
    const lost = await lostResponse(w, { buyer_id: 'buy_A', offers: ['ofr_2'] });
    w.tick(40_000); // all three are due; the refund became due first, the capture last

    const order: string[] = [];
    const refundWork = (): number => w.refundCalls.length + w.getRefundCalls.length;
    const refundsBefore = refundWork();
    const createsBefore = w.paypal.count('create');
    // one item per pass shows the order
    for (let i = 0; i < 3; i += 1) {
      await runDue(w.deps, { max_items: 1 });
      if ((await orderStatus(w, lost.order_id)) === 'paid' && !order.includes('capture')) {
        order.push('capture');
      } else if (w.paypal.count('create') > createsBefore && !order.includes('create')) {
        order.push('create');
      } else if (refundWork() > refundsBefore && !order.includes('refund')) {
        order.push('refund');
      }
    }
    expect(order).toEqual(['capture', 'create', 'refund']);
  });

  it('with one item left, an unknown capture is read and the due paid re-read waits', async () => {
    w = await makeWorld();
    const watcher = await paid(w);
    const lost = await lostResponse(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    w.tick(H + 1000);
    const before = gets(watcher.provider_order_id);
    const r = await runDue(w.deps, { max_items: 1 });
    expect(r.processed).toBe(1);
    expect(await orderStatus(w, lost.order_id)).toBe('paid');
    expect(gets(watcher.provider_order_id)).toBe(before);
  });
});

/** The same deps with a provider that refuses (blocked by budget) once `left` calls are used. */
function withQuota(left: number): { deps: PaymentsDeps; quota: { left: number } } {
  const quota = { left };
  const paypal = new Proxy(w.deps.paypal, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): Promise<unknown> => {
        if (quota.left <= 0) return Promise.resolve({ kind: 'blocked', by: 'budget' });
        quota.left -= 1;
        return Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args));
      };
    },
  });
  return { deps: { ...w.deps, paypal }, quota };
}

describe('F1: the call quota can run out in the middle of an item', () => {
  it('an abandoned-but-approved order costs 4 calls; with 1, 2 or 3 the pass stops safely and the next pass finishes it', async () => {
    w = await makeWorld();
    const a = await approved(w); // approved at PayPal, the buyer never came back
    w.tick(DAY + 1000);
    for (const n of [1, 2, 3]) {
      const before = w.paypal.calls.length;
      const { deps } = withQuota(n);
      await runDue(deps, { max_items: 1, allow: 'all' });
      expect(w.paypal.calls.length - before, `quota ${n}`).toBeLessThanOrEqual(n);
      expect(w.paypal.count('capture')).toBeLessThanOrEqual(1);
      expect(['awaiting_buyer', 'capture_requested', 'unresolved', 'paid']).toContain(
        await orderStatus(w, a.order_id),
      );
    }
    // with enough calls the capture goes through once, exactly as the sweep intends
    await runDue(w.deps, { max_items: 5, allow: 'all' });
    for (let i = 0; i < 3 && (await orderStatus(w, a.order_id)) !== 'paid'; i += 1) {
      w.tick(60_000);
      await runDue(w.deps, { max_items: 5, allow: 'all' });
    }
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(w.paypal.count('capture')).toBe(1);
    expect(
      Number(
        (
          await w.rows<{ n: string }>(
            "SELECT count(*)::int AS n FROM ledger_entries WHERE kind = 'sale'",
          )
        )[0]!.n,
      ),
    ).toBe(1);
  }, 300_000);

  it('an unknown capture with the P3 retry costs 3 calls; with 1 or 2 nothing is lost or sent twice under another key', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.tick(61_000); // the lease of the dead process ran out
    for (const n of [1, 2]) {
      const before = w.paypal.calls.length;
      const { deps } = withQuota(n);
      await runDue(deps, { max_items: 1, allow: 'money_only' });
      expect(w.paypal.calls.length - before, `quota ${n}`).toBeLessThanOrEqual(n);
      w.tick(3_700_000); // past the backoff, inside the 5 h key window
    }
    await runDue(w.deps, { max_items: 5, allow: 'money_only' });
    for (let i = 0; i < 3 && (await orderStatus(w, a.order_id)) !== 'paid'; i += 1) {
      w.tick(3_700_000);
      await runDue(w.deps, { max_items: 5, allow: 'money_only' });
    }
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    const keys = new Set(w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id));
    expect(keys.size).toBe(1); // every send used the original key
    expect(
      Number(
        (
          await w.rows<{ n: string }>(
            "SELECT count(*)::int AS n FROM ledger_entries WHERE kind = 'sale'",
          )
        )[0]!.n,
      ),
    ).toBe(1);
  }, 300_000);
});
