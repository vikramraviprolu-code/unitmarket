// State tests of the due-work runner (lane 05b): ordering, limits, abandoned checkouts (P17), the
// hourly re-read of paid orders, stale leases, nextDueAt. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { nextDueAt, runDue } from './index';
import { markUnknown } from './due';
import {
  alertKinds,
  approved,
  awaiting,
  count,
  deadCapture,
  lostResponse,
  makeWorld,
  opOf,
  orderStatus,
  paid,
  place,
  sentCapture,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;
const money = async (order_id: string): Promise<string[]> =>
  (
    await w.rows<{ money_state: string }>(
      `SELECT e.money_state FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1 ORDER BY e.id`,
      [order_id],
    )
  ).map((r) => r.money_state);

describe('abandoned checkouts (P17)', () => {
  it('abandoned at 24 h: not approved, so abandoned with no charge', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.tick(DAY - 1000);
    expect((await runDue(w.deps, { max_items: 10 })).abandoned).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    w.tick(2000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(1);
    expect(r.processed).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await money(a.order_id)).toEqual(['denied']);
    expect(
      (await w.rows<{ status: string }>('SELECT status FROM order_units')).map((x) => x.status),
    ).toEqual(['declined']);
    expect(w.paypal.count('capture')).toBe(0);
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await runDue(w.deps, { max_items: 10 })).toEqual({
      processed: 0,
      still_unknown: 0,
      expired: 0,
      abandoned: 0,
    });
  });
  it('abandoned at 24 h: APPROVED captures once, by the 05a path', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.tick(DAY + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(0);
    expect(w.paypal.count('capture')).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('a capture found on an order nobody captured is never abandoned: taken over, alerted, booked from the read', async () => {
    w = await makeWorld();
    const a = await approved(w);
    await w.paypal.captureOrder({
      provider_order_id: a.provider_order_id,
      request_id: 'someone-else',
    });
    w.tick(DAY + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await alertKinds(w, a.order_id)).toContain('unexpected_capture');
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
  it('checkout switch off: an approved order is left waiting, not abandoned', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.switches.checkout_enabled = false;
    w.tick(DAY + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(0);
    expect(w.paypal.count('capture')).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });
  it('outbound switch off: nothing is read and nothing is abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.switches.paypal_outbound = false;
    w.tick(DAY + 1000);
    const before = w.paypal.calls.length;
    expect((await runDue(w.deps, { max_items: 10 })).abandoned).toBe(0);
    expect(w.paypal.calls.length).toBe(before);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });
  it('a read that fails leaves the order waiting for the next pass', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.tick(DAY + 1000);
    w.paypal.queue.get.push({ kind: 'timeout' });
    expect((await runDue(w.deps, { max_items: 10 })).abandoned).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect((await runDue(w.deps, { max_items: 10 })).abandoned).toBe(1);
  });
  it('an order that never reached the buyer (create never sent) is abandoned after 24 h with no call', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.tick(DAY + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(1);
    expect(await orderStatus(w, p.order_id)).toBe('abandoned');
    expect(w.paypal.calls).toHaveLength(0);
  });
  it('max_items bounds the sweep too', async () => {
    w = await makeWorld();
    await awaiting(w);
    await awaiting(w, { buyer_id: 'buy_B' });
    await awaiting(w, { offers: ['ofr_2'] });
    w.tick(DAY + 1000);
    expect((await runDue(w.deps, { max_items: 2 })).abandoned).toBe(2);
    expect((await runDue(w.deps, { max_items: 2 })).abandoned).toBe(1);
  });
});

describe('ordering, limits and leases', () => {
  it('due operations run ordered by (next_retry_at, id) and max_items bounds a pass', async () => {
    w = await makeWorld();
    const first = await lostResponse(w);
    w.tick(10_000);
    const second = await lostResponse(w, { buyer_id: 'buy_B' });
    w.tick(40_000); // both are due; the first became due earlier
    const r1 = await runDue(w.deps, { max_items: 1 });
    expect(r1.processed).toBe(1);
    expect(await orderStatus(w, first.order_id)).toBe('paid');
    expect(await orderStatus(w, second.order_id)).toBe('unresolved');
    const r2 = await runDue(w.deps, { max_items: 1 });
    expect(r2.processed).toBe(1);
    expect(await orderStatus(w, second.order_id)).toBe('paid');
  });
  it('a non-positive max_items does nothing', async () => {
    w = await makeWorld();
    await lostResponse(w);
    const gets = w.paypal.count('get');
    w.tick(31_000);
    expect((await runDue(w.deps, { max_items: 0 })).processed).toBe(0);
    expect(w.paypal.count('get')).toBe(gets);
  });
  it('a sent operation is left alone until its lease ran out, then read first', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    w.tick(30_000);
    expect((await runDue(w.deps, { max_items: 10 })).processed).toBe(0);
    expect(w.paypal.count('get')).toBe(1); // only the buyer's pre-capture read
    w.tick(31_000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.processed).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('a dead capture whose lease ran out is read, then retried with the same key', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('an operation already taken by another worker is not processed twice', async () => {
    w = await makeWorld();
    await lostResponse(w);
    w.tick(31_000);
    const [x, y] = await Promise.all([
      runDue(w.deps, { max_items: 10 }),
      runDue(w.deps, { max_items: 10 }),
    ]);
    expect(x.processed + y.processed).toBe(1);
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
});

describe('hourly re-read of paid orders for 7 days', () => {
  it('reads each hour, not before, and stops after 7 days', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const gets = (): number => w.paypal.count('get');
    const base = gets();
    w.tick(H - 1000);
    await runDue(w.deps, { max_items: 10 });
    expect(gets()).toBe(base);
    w.tick(2000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.processed).toBe(1);
    expect(gets()).toBe(base + 1);
    await runDue(w.deps, { max_items: 10 });
    expect(gets()).toBe(base + 1);
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });
    expect(gets()).toBe(base + 2);
    w.tick(7 * DAY - 2 * H - 30 * 60_000); // 6 d 21 h 30 min after the capture: still inside
    await runDue(w.deps, { max_items: 10 });
    expect(gets()).toBe(base + 3);
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });
    expect(gets()).toBe(base + 3); // past 7 days: no more reads
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('a clean re-read changes nothing: one sale, one window', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const win = await w.rows('SELECT * FROM access_windows');
    w.tick(H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect(await w.rows('SELECT * FROM access_windows')).toEqual(win);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'receipts')).toBe(1);
    expect(await alertKinds(w, a.order_id)).toEqual([]);
  });
});

describe('nextDueAt', () => {
  it('null when nothing waits', async () => {
    w = await makeWorld();
    expect(await nextDueAt(w.db)).toBeNull();
  });
  it('the earliest of: an unknown operation, an abandoned-checkout time, a paid re-read', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const t0 = w.clock.now().getTime();
    expect(await nextDueAt(w.db)).toBe(new Date(t0 + DAY).toISOString());
    await lostResponse(w, { buyer_id: 'buy_B' });
    expect(await nextDueAt(w.db)).toBe(new Date(t0 + 30_000).toISOString());
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    // The lost capture is paid now: its first re-read is an hour after the capture.
    const verified = (
      await w.rows<{ t: Date }>('SELECT max(captured_verified_at) AS t FROM order_units')
    )[0]!.t;
    expect(await nextDueAt(w.db)).toBe(new Date(verified.getTime() + H).toISOString());
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });
  it('an operation that is overdue is due now: not later than any other', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    const op = await opOf(w, a.order_id, 'capture');
    w.tick(10 * H);
    expect(await nextDueAt(w.db)).toBe(op.next_retry_at!.toISOString());
  });
});

describe('guards', () => {
  it('a max_items that is not a positive whole number does nothing', async () => {
    w = await makeWorld();
    await lostResponse(w);
    const gets = w.paypal.count('get');
    w.tick(31_000);
    for (const max_items of [-5, 1.5, Number.NaN]) {
      expect(await runDue(w.deps, { max_items })).toEqual({
        processed: 0,
        still_unknown: 0,
        expired: 0,
        abandoned: 0,
      });
    }
    expect(w.paypal.count('get')).toBe(gets);
  });
  it('an APPROVED order whose capture needs the payer again is abandoned, nothing charged', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=again',
      debug_id: null,
    });
    w.tick(DAY + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.abandoned).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('failed');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });
  it('markUnknown moves only an operation that is in the state it is told', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const op = await opOf(w, a.order_id, 'capture'); // confirmed
    const moved = await w.db.transaction((tx) =>
      markUnknown(
        tx,
        w.deps,
        {
          id: op.id,
          order_id: a.order_id,
          kind: 'capture',
          first_sent_at: null,
          request_id: op.request_id,
        },
        'sent',
      ),
    );
    expect(moved).toBe(false);
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('confirmed');
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
});
