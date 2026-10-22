// State tests of placeOrder and beginCheckout (lane 05a, steps 5 to 8 of the journey). The
// database is a real PGlite with every migration; PayPal is the scripted port of support.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { isUrlUnderOrigin } from '@umsbx/contracts';
import { beginCheckout, placeOrder, requestIdFor } from './index';
import { BUYER_A, BUYER_B, count, makeWorld, place } from './support';
import type { World } from './support';

let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

describe('placeOrder: one transaction writes everything before any call', () => {
  it('writes order, expected transaction, unit, entitlement and prepared create operation; no PayPal call', async () => {
    w = await makeWorld();
    const p = await place(w);
    expect(w.paypal.calls).toEqual([]);

    const [order] = await w.rows<Record<string, unknown>>('SELECT * FROM orders WHERE id = $1', [
      p.order_id,
    ]);
    expect(order).toMatchObject({
      status: 'created',
      buyer_id: 'buy_A',
      order_ref: p.order_ref,
      approval_id: p.approval.approval_id,
      content_hash: p.approval.content_hash,
      currency: 'USD',
      total_minor: 400,
      corridor_id: 'us-usd',
      mismatch: false,
      environment: 'dryrun',
    });
    expect(p.order_ref).not.toBe(p.order_id);

    const units = await w.rows<Record<string, unknown>>(
      'SELECT * FROM order_units WHERE order_id = $1',
      [p.order_id],
    );
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      publisher_id: 'pub_1',
      payee_merchant_id: 'MERCH1',
      amount_minor: 400,
      platform_fee_minor: 0,
      status: 'expected',
      capture_id: null,
      refunded_minor: 0,
    });
    // The reference id is the unit id: PayPal echoes it back.
    expect(units[0]!.reference_id).toBe(units[0]!.id);

    const expected =
      typeof order!.expected === 'string' ? JSON.parse(order!.expected) : order!.expected;
    expect(expected).toMatchObject({
      order_ref: p.order_ref,
      buyer_id: 'buy_A',
      content_hash: p.approval.content_hash,
      currency: 'USD',
      total_minor: 400,
      environment: 'dryrun',
      units: [
        {
          reference_id: units[0]!.id,
          publisher_id: 'pub_1',
          payee_merchant_id: 'MERCH1',
          amount_minor: 400,
        },
      ],
    });

    const po = await w.rows<Record<string, unknown>>(
      'SELECT * FROM provider_orders WHERE order_id = $1',
      [p.order_id],
    );
    expect(po).toHaveLength(1);
    expect(po[0]).toMatchObject({ route: 'single', provider_order_id: null, approve_url: null });
    expect(units[0]!.provider_order_ref).toBe(po[0]!.id);

    const ents = await w.rows<Record<string, unknown>>(
      'SELECT * FROM entitlements WHERE unit_id = $1',
      [units[0]!.id],
    );
    expect(ents).toHaveLength(1);
    expect(ents[0]).toMatchObject({
      article_id: 'art_1',
      money_state: 'pending',
      access_state: 'locked',
    });

    const ops = await w.rows<Record<string, unknown>>(
      'SELECT * FROM operations WHERE order_id = $1',
      [p.order_id],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'create',
      state: 'prepared',
      request_id: requestIdFor('create', p.order_ref),
      attempt: 1,
    });
    expect(ops[0]!.lease_until).not.toBeNull();

    const [ap] = await w.rows<{ used_at: Date | null }>(
      'SELECT used_at FROM approvals WHERE id = $1',
      [p.approval.approval_id],
    );
    expect(ap!.used_at).not.toBeNull();
  });

  it('A-10: order, expected transaction, unit, entitlement and prepared operation exist when the transport sees create', async () => {
    w = await makeWorld();
    const p = await place(w);
    let seen: Record<string, unknown> | null = null;
    w.paypal.beforeCreate = async () => {
      const ord = await w.rows<{ status: string; expected: unknown }>(
        'SELECT status, expected FROM orders WHERE id = $1',
        [p.order_id],
      );
      const op = await w.rows<{ state: string; request_id: string; first_sent_at: Date | null }>(
        "SELECT state, request_id, first_sent_at FROM operations WHERE order_id = $1 AND kind = 'create'",
        [p.order_id],
      );
      seen = {
        orders: ord.length,
        status: ord[0]?.status,
        expected: ord[0]?.expected !== undefined && ord[0]?.expected !== null,
        units: await count(w, 'order_units', `order_id = '${p.order_id}'`),
        entitlements: await count(w, 'entitlements', "money_state = 'pending'"),
        op: op[0],
      };
    };
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c.ok).toBe(true);
    expect(seen).toMatchObject({
      orders: 1,
      status: 'created',
      expected: true,
      units: 1,
      entitlements: 1,
    });
    expect((seen as unknown as { op: { request_id: string; state: string } }).op).toMatchObject({
      request_id: requestIdFor('create', p.order_ref),
      state: 'sent',
    });
  });

  it('a two-publisher approval writes one unit per publisher and one entitlement per item', async () => {
    w = await makeWorld();
    const p = await place(w, { offers: ['ofr_1', 'ofr_2', 'ofr_3'] });
    const units = await w.rows<{ publisher_id: string; amount_minor: number }>(
      'SELECT publisher_id, amount_minor FROM order_units WHERE order_id = $1 ORDER BY publisher_id',
      [p.order_id],
    );
    expect(units).toEqual([
      { publisher_id: 'pub_1', amount_minor: 800 },
      { publisher_id: 'pub_2', amount_minor: 400 },
    ]);
    expect(await count(w, 'entitlements')).toBe(3);
    const [o] = await w.rows<{ total_minor: number }>(
      'SELECT total_minor FROM orders WHERE id = $1',
      [p.order_id],
    );
    expect(o!.total_minor).toBe(1200);
  });

  it('checkout_enabled off refuses a new order with 503 and writes nothing', async () => {
    w = await makeWorld();
    const approval = await w.approval();
    w.switches.checkout_enabled = false;
    const r = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    expect(r).toEqual({ ok: false, error: { code: 'checkout_off', http: 503 } });
    expect(await count(w, 'orders')).toBe(0);
    expect(await count(w, 'operations')).toBe(0);
    const [ap] = await w.rows<{ used_at: Date | null }>(
      'SELECT used_at FROM approvals WHERE id = $1',
      [approval.approval_id],
    );
    expect(ap!.used_at).toBeNull();
  });

  it('a tampered token is refused with 403 and writes nothing', async () => {
    w = await makeWorld();
    const approval = await w.approval();
    const bad = approval.token.slice(0, -1) + (approval.token.endsWith('A') ? 'B' : 'A');
    const r = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: bad,
      actor: BUYER_A,
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'approval', error: { code: 'bad_token', http: 403 } },
    });
    expect(await count(w, 'orders')).toBe(0);
    expect(await count(w, 'order_units')).toBe(0);
    expect(await count(w, 'entitlements')).toBe(0);
    expect(await count(w, 'operations')).toBe(0);
  });

  it('an expired approval (15 minutes) is refused with 410; at 14:59 it still works', async () => {
    w = await makeWorld();
    const a1 = await w.approval();
    w.clock.advance(899_000);
    const ok = await placeOrder(w.deps, {
      approval_id: a1.approval_id,
      token: a1.token,
      actor: BUYER_A,
    });
    expect(ok.ok).toBe(true);
    const a2 = await w.approval({ offers: ['ofr_3'] });
    w.clock.advance(900_000);
    const late = await placeOrder(w.deps, {
      approval_id: a2.approval_id,
      token: a2.token,
      actor: BUYER_A,
    });
    expect(late).toEqual({
      ok: false,
      error: { code: 'approval', error: { code: 'expired', http: 410 } },
    });
  });

  it("another buyer's approval is not found for the caller: 404, no rows", async () => {
    w = await makeWorld();
    const approval = await w.approval({ buyer_id: 'buy_A' });
    const r = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_B,
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'approval', error: { code: 'not_owner', http: 404 } },
    });
    expect(await count(w, 'orders')).toBe(0);
  });

  it('a second approval of the same content while an order is open: order_open 409, approval stays unused', async () => {
    w = await makeWorld();
    await place(w);
    const again = await w.approval();
    const r = await placeOrder(w.deps, {
      approval_id: again.approval_id,
      token: again.token,
      actor: BUYER_A,
    });
    expect(r).toEqual({ ok: false, error: { code: 'order_open', http: 409 } });
    expect(await count(w, 'orders')).toBe(1);
    const [ap] = await w.rows<{ used_at: Date | null }>(
      'SELECT used_at FROM approvals WHERE id = $1',
      [again.approval_id],
    );
    expect(ap!.used_at).toBeNull();
  });

  it('once the first order has failed, the same content can be ordered again', async () => {
    w = await makeWorld();
    const first = await place(w);
    await w.db.query("UPDATE orders SET status = 'failed' WHERE id = $1", [first.order_id]);
    const again = await place(w);
    expect(again.order_id).not.toBe(first.order_id);
    expect(await count(w, 'orders')).toBe(2);
  });

  it('the same content by another buyer is not an open order for this buyer', async () => {
    w = await makeWorld();
    await place(w, { buyer_id: 'buy_A' });
    const b = await place(w, { buyer_id: 'buy_B' });
    expect(b.order_id).toBeTruthy();
  });
});

describe('beginCheckout: create operation, idempotency key, outcomes', () => {
  it('created: stores the provider id and approve URL, operation confirmed, order awaiting_buyer', async () => {
    w = await makeWorld();
    const p = await place(w);
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.approve_url).toMatch(
      /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=SBXFAKEORD/,
    );

    const [po] = await w.rows<{ provider_order_id: string; approve_url: string; status: string }>(
      'SELECT provider_order_id, approve_url, status FROM provider_orders WHERE order_id = $1',
      [p.order_id],
    );
    expect(po!.approve_url).toBe(c.value.approve_url);
    expect(po!.provider_order_id).toMatch(/^SBXFAKEORD/);
    const [op] = await w.rows<Record<string, unknown>>(
      "SELECT * FROM operations WHERE order_id = $1 AND kind = 'create'",
      [p.order_id],
    );
    expect(op).toMatchObject({
      state: 'confirmed',
      lease_until: null,
      request_id: requestIdFor('create', p.order_ref),
    });
    const [o] = await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      p.order_id,
    ]);
    expect(o!.status).toBe('awaiting_buyer');
  });

  it('sets first_sent_at and idem_safe_until = first_sent_at + the safe window', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.clock.advance(1_000);
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const [op] = await w.rows<{ first_sent_at: Date; idem_safe_until: Date }>(
      "SELECT first_sent_at, idem_safe_until FROM operations WHERE order_id = $1 AND kind = 'create'",
      [p.order_id],
    );
    expect(op!.first_sent_at.toISOString()).toBe('2026-10-22T10:00:01.000Z');
    expect(op!.idem_safe_until.getTime() - op!.first_sent_at.getTime()).toBe(18_000_000);
  });

  it('sends the stored expected side: reference id = unit id, payee, amount, order ref, same-origin return URLs', async () => {
    w = await makeWorld();
    const p = await place(w);
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A, scenario: 'happy' });
    const [u] = await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [
      p.order_id,
    ]);
    const o = [...w.paypal.orders.values()][0]!;
    expect(o.req).toMatchObject({
      request_id: `umsC-${p.order_ref}`,
      order_ref: p.order_ref,
      scenario: 'happy',
      units: [
        {
          reference_id: u!.id,
          payee_merchant_id: 'MERCH1',
          amount: { currency: 'USD', minor: 400 },
        },
      ],
    });
    for (const url of [o.req.return_url, o.req.cancel_url]) {
      expect(isUrlUnderOrigin(url, 'http://localhost:3000')).toBe(true);
      expect(url).toContain(p.order_ref);
    }
    expect(o.req.return_url).toContain('/checkout/return');
    expect(o.req.cancel_url).toContain('/checkout/cancel');
  });

  it('a repeated beginCheckout on an awaiting order returns the stored URL and makes no second call', async () => {
    w = await makeWorld();
    const p = await place(w);
    const first = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const second = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(second).toEqual(first);
    expect(w.paypal.count('create')).toBe(1);
  });

  it('not_found for another buyer and for an unknown order, with no call', async () => {
    w = await makeWorld();
    const p = await place(w);
    expect(await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_B })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await beginCheckout(w.deps, { order_id: 'ord_NOPE', actor: BUYER_A })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(w.paypal.calls).toEqual([]);
  });

  it('wrong_state for an order that is not new (paid, failed, frozen) with no call', async () => {
    w = await makeWorld();
    for (const status of ['frozen', 'failed', 'unresolved']) {
      const p = await place(w, {
        offers: [`ofr_${status === 'frozen' ? 1 : status === 'failed' ? 2 : 3}`],
      });
      await w.db.query('UPDATE orders SET status = $2 WHERE id = $1', [p.order_id, status]);
      expect(await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A })).toEqual({
        ok: false,
        error: { code: 'wrong_state' },
      });
    }
    expect(w.paypal.calls).toEqual([]);
  });

  it('checkout_enabled off: payments_paused, no call, operation stays prepared', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.switches.checkout_enabled = false;
    expect(await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A })).toEqual({
      ok: false,
      error: { code: 'payments_paused' },
    });
    expect(w.paypal.calls).toEqual([]);
    const [op] = await w.rows<{ state: string }>(
      "SELECT state FROM operations WHERE order_id = $1 AND kind = 'create'",
      [p.order_id],
    );
    expect(op!.state).toBe('prepared');
  });

  it('rejected 422: operation failed/rejected, order failed, items declined, nothing charged', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'PAYEE_ACCOUNT_RESTRICTED',
      debug_id: 'D1',
    });
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c).toEqual({ ok: false, error: { code: 'create_failed' } });
    const [op] = await w.rows<Record<string, unknown>>(
      "SELECT state, failure_reason FROM operations WHERE order_id = $1 AND kind = 'create'",
      [p.order_id],
    );
    expect(op).toMatchObject({ state: 'failed', failure_reason: 'rejected' });
    const [o] = await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      p.order_id,
    ]);
    expect(o!.status).toBe('failed');
    const [u] = await w.rows<{ status: string }>(
      'SELECT status FROM order_units WHERE order_id = $1',
      [p.order_id],
    );
    expect(u!.status).toBe('declined');
    const [e] = await w.rows<{ money_state: string; access_state: string }>(
      'SELECT money_state, access_state FROM entitlements',
    );
    expect(e).toEqual({ money_state: 'denied', access_state: 'locked' });
    expect(await count(w, 'ledger_entries')).toBe(0);
  });

  it('rejected 400 invalid request: failure_reason invalid_request and an alert; no retry', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 400,
      name: 'INVALID_REQUEST',
      issue: 'MALFORMED_REQUEST_JSON',
      debug_id: 'D2',
    });
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const [op] = await w.rows<{ failure_reason: string }>(
      "SELECT failure_reason FROM operations WHERE order_id = $1 AND kind = 'create'",
      [p.order_id],
    );
    expect(op!.failure_reason).toBe('invalid_request');
    expect(await count(w, 'alerts', "kind = 'create_rejected'")).toBe(1);
    expect(await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A })).toEqual({
      ok: false,
      error: { code: 'wrong_state' },
    });
    expect(w.paypal.count('create')).toBe(1);
  });

  it.each([
    ['timeout', { kind: 'timeout' }],
    ['unavailable', { kind: 'unavailable', retry_after_ms: null }],
    ['in_progress', { kind: 'in_progress', debug_id: null }],
  ] as const)(
    '%s: operation unknown with reconcile_until and next_retry_at; order stays created; no second call',
    async (_n, fail) => {
      w = await makeWorld();
      const p = await place(w);
      w.paypal.queue.create.push(fail);
      const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
      expect(c).toEqual({ ok: false, error: { code: 'create_failed' } });
      const [op] = await w.rows<{
        state: string;
        reconcile_until: Date;
        next_retry_at: Date;
        first_sent_at: Date;
        lease_until: Date | null;
      }>(
        "SELECT state, reconcile_until, next_retry_at, first_sent_at, lease_until FROM operations WHERE order_id = $1 AND kind = 'create'",
        [p.order_id],
      );
      expect(op!.state).toBe('unknown');
      expect(op!.reconcile_until.getTime() - op!.first_sent_at.getTime()).toBe(86_400_000);
      expect(op!.next_retry_at.getTime() - w.clock.now().getTime()).toBe(30_000);
      expect(op!.lease_until).toBeNull();
      const [o] = await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
        p.order_id,
      ]);
      expect(o!.status).toBe('created');
      // The buyer pressing the button again does not create a second PayPal order.
      expect(await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A })).toEqual({
        ok: false,
        error: { code: 'wrong_state' },
      });
      expect(w.paypal.count('create')).toBe(1);
    },
  );

  it('blocked by the kill switch: operation unknown, answer payments_paused, order unchanged', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.paypal.queue.create.push({ kind: 'blocked', by: 'kill_switch' });
    expect(await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A })).toEqual({
      ok: false,
      error: { code: 'payments_paused' },
    });
    const [op] = await w.rows<{ state: string }>(
      "SELECT state FROM operations WHERE order_id = $1 AND kind = 'create'",
      [p.order_id],
    );
    expect(op!.state).toBe('unknown');
    const [o] = await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      p.order_id,
    ]);
    expect(o!.status).toBe('created');
  });
});
