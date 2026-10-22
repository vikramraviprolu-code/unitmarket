// State tests of the reconciler (lane 05b): lost capture answers, the retry rule, the 5 h resend
// limit, the 24 h window, backoff, the paused switch. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { beginCheckout, reconcileOrder, runDue } from './index';
import {
  BUYER_A,
  alertKinds,
  count,
  deadCapture,
  lostResponse,
  makeWorld,
  opOf,
  ops,
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
const timeouts = (n: number) => Array.from({ length: n }, () => ({ kind: 'timeout' as const }));
const access = async (order_id: string): Promise<string[]> =>
  (
    await w.rows<{ access_state: string }>(
      `SELECT e.access_state FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1 ORDER BY e.id`,
      [order_id],
    )
  ).map((r) => r.access_state);

describe('lost capture response (A-14, REL-3)', () => {
  it('read shows COMPLETED, one capture, unlocked once', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    expect(
      (await ops(w, a.order_id)).filter((o) => o.kind === 'capture').map((o) => [o.kind, o.state]),
    ).toEqual([['capture', 'unknown']]);

    // Not due yet: nothing happens before the first backoff.
    const gets = w.paypal.count('get');
    w.tick(29_000);
    expect((await runDue(w.deps, { max_items: 10 })).processed).toBe(0);
    expect(w.paypal.count('get')).toBe(gets);

    w.tick(2_000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.processed).toBe(1);
    expect(r.still_unknown).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await access(a.order_id)).toEqual(['available']);
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('confirmed');
    // Read first: the read came before anything else, and the capture was never sent again.
    expect(w.paypal.calls.map((c) => c.op)).toEqual(['create', 'get', 'capture', 'get']);
  });
  it('a second pass changes nothing', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    const before = w.paypal.calls.length;
    const again = await runDue(w.deps, { max_items: 10 });
    expect(again).toEqual({ processed: 0, still_unknown: 0, expired: 0, abandoned: 0 });
    expect(w.paypal.calls.length).toBe(before);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await access(a.order_id)).toEqual(['available']);
  });
});

describe('capture retry (P3): only after a read shows no capture, same key, inside 5 h', () => {
  it('read shows no capture: one retry with the same key inside 5 h', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    expect(w.paypal.count('capture')).toBe(1);
    w.tick(61_000); // the lease of the dead call ran out
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.processed).toBe(1);
    const captures = w.paypal.calls.filter((c) => c.op === 'capture');
    expect(captures).toHaveLength(2);
    expect(captures[1]!.request_id).toBe(captures[0]!.request_id);
    expect(captures[0]!.request_id).toBe(`umsK-${a.order_ref}`);
    // A read came before the retry.
    const seq = w.paypal.calls.map((c) => c.op);
    expect(seq.lastIndexOf('get', seq.lastIndexOf('capture') - 1)).toBeGreaterThan(
      seq.indexOf('capture'),
    );
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
  it('none after 5 h: the key may be forgotten, so no capture is sent', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.tick(5 * H + 60_000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(1);
    expect(r.still_unknown).toBe(1);
    expect(w.paypal.count('get')).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
  });
  it('exactly at the limit: the retry is allowed only strictly before idem_safe_until', async () => {
    w = await makeWorld();
    await deadCapture(w);
    w.tick(5 * H); // now == idem_safe_until
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('one retry only: a second no-capture read sends nothing more (1 + max_capture_retries)', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.paypal.queue.capture.push({ kind: 'timeout' }); // the retry is lost too
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(2);
    expect((await opOf(w, a.order_id, 'capture')).attempt).toBe(2);
    for (let k = 0; k < 6; k += 1) {
      w.tick(20 * 60_000);
      await runDue(w.deps, { max_items: 10 });
    }
    expect(w.paypal.count('capture')).toBe(2);
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
  });
  it('no retry when the delivery check fails: nothing is charged into a locked door', async () => {
    w = await makeWorld();
    await deadCapture(w);
    w.content.healthy = true;
    w.content.heads.clear();
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('no retry while the order is not approved at PayPal', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.paypal.orders.get(a.provider_order_id)!.status = 'CREATED';
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('capture')).toBe(1);
  });
  it('a refused retry that needs the payer reopens the order for the buyer, no second charge', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.paypal.queue.capture.push({
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=again',
      debug_id: null,
    });
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect(w.paypal.count('capture')).toBe(2);
  });
  it('a duplicate-invoice refusal freezes the order', async () => {
    w = await makeWorld();
    const a = await deadCapture(w);
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('frozen');
    expect(await alertKinds(w, a.order_id)).toContain('frozen_order');
  });
});

describe('create unknown (5 h resend limit)', () => {
  it('resends with the same key inside the window and finishes the checkout', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({ kind: 'timeout' });
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c.ok).toBe(false);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('unknown');
    w.tick(31_000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.processed).toBe(1);
    const creates = w.paypal.calls.filter((x) => x.op === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.request_id).toBe(creates[0]!.request_id);
    expect(await orderStatus(w, p.order_id)).toBe('awaiting_buyer');
    expect(w.paypal.orders.size).toBe(1);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('confirmed');
    expect(
      (
        await w.rows<{ provider_order_id: string | null }>(
          'SELECT provider_order_id FROM provider_orders',
        )
      )[0]!.provider_order_id,
    ).not.toBeNull();
  });
  it('create unknown past 5 h never resends and raises payment_unresolved', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({ kind: 'timeout' }, { kind: 'timeout' });
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 }); // resend inside the window, lost again
    expect(w.paypal.count('create')).toBe(2);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('unknown');

    w.tick(5 * H);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('create')).toBe(2);
    expect(r.expired).toBe(1);
    const op = await opOf(w, p.order_id, 'create');
    expect([op.state, op.failure_reason]).toEqual(['failed', 'window_expired']);
    // No provider order id was ever stored: nothing can have been charged.
    expect(await orderStatus(w, p.order_id)).toBe('failed');
    expect(await alertKinds(w, p.order_id)).toEqual(['payment_unresolved']);
    // Items are released, once.
    expect(
      (await w.rows<{ money_state: string }>('SELECT money_state FROM entitlements')).map(
        (x) => x.money_state,
      ),
    ).toEqual(['denied']);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('create')).toBe(2);
    expect(await count(w, 'alerts', "kind = 'payment_unresolved'")).toBe(1);
  });
  it('a rejected resend fails the order and raises create_rejected', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push(
      { kind: 'timeout' },
      { kind: 'rejected', http: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'X', debug_id: 'D' },
    );
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, p.order_id)).toBe('failed');
    expect(await alertKinds(w, p.order_id)).toEqual(['create_rejected']);
  });
});

describe('24 h window (INC-2)', () => {
  it('24 h expiry alerts once and never re-charges', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.paypal.queue.get.push(...timeouts(300)); // PayPal cannot be read for a day
    for (let k = 0; k < 60; k += 1) {
      w.tick(30 * 60_000);
      await runDue(w.deps, { max_items: 10 });
    }
    expect(w.paypal.count('capture')).toBe(1);
    const op = await opOf(w, a.order_id, 'capture');
    expect([op.state, op.failure_reason]).toEqual(['failed', 'window_expired']);
    expect(await alertKinds(w, a.order_id)).toEqual(['payment_unresolved']);
    // Money was possibly taken: the order is never failed by absence.
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    const before = w.paypal.calls.length;
    w.tick(48 * H);
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.calls.length).toBe(before);
    expect(await count(w, 'alerts', "kind = 'payment_unresolved'")).toBe(1);
  });
  it('the last read happens at the window end, and it can still settle the order', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.tick(24 * H + 1000);
    const r = await runDue(w.deps, { max_items: 10 });
    expect(r.expired).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await alertKinds(w, a.order_id)).toEqual([]);
  });
  it('a pending capture that never settles ends in payment_unresolved with its items unknown', async () => {
    w = await makeWorld();
    w.paypal.next.status = 'PENDING';
    w.paypal.next.reason = 'OTHER';
    const a = await lostResponse(w);
    for (let k = 0; k < 30; k += 1) {
      w.tick(H);
      await runDue(w.deps, { max_items: 10 });
    }
    expect(await orderStatus(w, a.order_id)).toBe('unresolved');
    expect(await alertKinds(w, a.order_id)).toEqual(['payment_unresolved']);
    expect(
      (await w.rows<{ money_state: string }>('SELECT money_state FROM entitlements')).map(
        (x) => x.money_state,
      ),
    ).toEqual(['unknown']);
    expect(w.paypal.count('capture')).toBe(1);
  });
});

describe('backoff', () => {
  it('backoff 30 s, 2 min, 10 min, 1 h, 1 h', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.paypal.queue.get.push(...timeouts(50));
    const next = async (): Promise<number> => {
      const o = await opOf(w, a.order_id, 'capture');
      return o.next_retry_at!.getTime();
    };
    const sentAt = w.clock.now().getTime();
    const times = [await next()];
    for (let k = 0; k < 5; k += 1) {
      w.clock.set(new Date(times[k]!).toISOString());
      await runDue(w.deps, { max_items: 10 });
      times.push(await next());
    }
    const gaps = times.map((t, k) => t - (k === 0 ? sentAt : times[k - 1]!));
    expect(gaps).toEqual([30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000]);
  });
});

describe('reconcileOrder', () => {
  it('paused: the outbound switch is off, no call is made and the order is untouched', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.switches.paypal_outbound = false;
    w.tick(31_000);
    const before = w.paypal.calls.length;
    expect(await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'manual' })).toEqual({
      skipped: 'paused',
    });
    expect(await runDue(w.deps, { max_items: 10 })).toEqual({
      processed: 0,
      still_unknown: 0,
      expired: 0,
      abandoned: 0,
    });
    expect(w.paypal.calls.length).toBe(before);
    expect((await opOf(w, a.order_id, 'capture')).state).toBe('unknown');
    w.switches.paypal_outbound = true;
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('terminal orders are skipped without a call', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'X',
      debug_id: 'D',
    });
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(await orderStatus(w, p.order_id)).toBe('failed');
    expect(await reconcileOrder(w.deps, { order_id: p.order_id, trigger: 'poll' })).toEqual({
      skipped: 'terminal',
    });
    expect(w.paypal.calls.filter((c) => c.op === 'get')).toHaveLength(0);
  });
  it('an unknown order id is an error, not a silent skip', async () => {
    w = await makeWorld();
    await expect(
      reconcileOrder(w.deps, { order_id: 'ord_missing', trigger: 'poll' }),
    ).rejects.toThrow();
  });
  it('a webhook or manual trigger reads and applies like a poll', async () => {
    w = await makeWorld();
    const a = await sentCapture(w);
    const r = await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'webhook' });
    expect('skipped' in r).toBe(false);
    if ('skipped' in r) return;
    expect(r.order_status).toBe('paid');
    expect(r.unlocked).toHaveLength(1);
    const again = await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'manual' });
    expect('skipped' in again ? null : again.unlocked).toEqual([]);
  });
  it('the unlock switch is read before the transaction: off means paid but locked, on later unlocks once', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    w.switches.unlock_enabled = false;
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await access(a.order_id)).toEqual(['locked']);
    w.switches.unlock_enabled = true;
    const r = await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'manual' });
    expect('skipped' in r ? 0 : r.unlocked.length).toBe(1);
    expect(await access(a.order_id)).toEqual(['available']);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
  it('a paid order stays paid when a later read is bad: flagged, not undone', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.paypal.tamper = { amount_delta: 1 };
    const r = await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' });
    expect('skipped' in r ? '' : r.order_status).toBe('paid');
    expect(await access(a.order_id)).toEqual(['available']);
  });
});
