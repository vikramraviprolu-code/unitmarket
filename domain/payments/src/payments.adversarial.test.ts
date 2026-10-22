// Adversarial tests (lane 05a): races, double submits, tampered tokens, a provider call inside a
// transaction, replays after every state. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { onBuyerReturn, placeOrder, beginCheckout } from './index';
import { BUYER_A, BUYER_B, approved, awaiting, count, makeWorld, place } from './support';
import type { World } from './support';

let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('capture race (P4)', () => {
  it('A-15: 20 concurrent returns make exactly one capture call', async () => {
    w = await makeWorld();
    const a = await approved(w);
    let release: () => void = () => undefined;
    w.paypal.hold = new Promise<void>((r) => {
      release = r;
    });
    const all = Array.from({ length: 20 }, () =>
      onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A }),
    );
    // Let the losers finish their attempts while the winner's capture call is still open.
    await tick(150);
    release();
    const results = await Promise.all(all);
    expect(w.paypal.count('capture')).toBe(1);
    expect(results.every((r) => r.ok || r.error.code === 'not_approved')).toBe(true);
    const wins = results.filter((r) => r.ok && r.value.status === 'paid');
    expect(wins.length).toBeGreaterThanOrEqual(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'receipts')).toBe(1);
    expect(await count(w, 'operations', "kind = 'capture'")).toBe(1);
    expect(w.paypal.calls.find((c) => c.op === 'capture')!.request_id).toBe(`umsK-${a.order_ref}`);
  });

  it('20 concurrent returns without any hold also make one capture call', async () => {
    w = await makeWorld();
    const a = await approved(w);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A }),
      ),
    );
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });

  it('concurrent beginCheckout makes one create call', async () => {
    w = await makeWorld();
    const p = await place(w);
    const rs = await Promise.all(
      Array.from({ length: 10 }, () =>
        beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A }),
      ),
    );
    expect(w.paypal.count('create')).toBe(1);
    expect(rs.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
  });

  it('after every kind of ending, more returns never capture again', async () => {
    const endings: [string, (x: World) => void][] = [
      ['paid', () => undefined],
      ['declined', (x) => (x.paypal.next = { ...x.paypal.next, status: 'DECLINED', fee: null })],
      [
        'pending',
        (x) =>
          (x.paypal.next = { ...x.paypal.next, status: 'PENDING', reason: 'ECHECK', fee: null }),
      ],
      ['lost answer', (x) => (x.paypal.next = { ...x.paypal.next, lose_response: true })],
    ];
    for (const [, set] of endings) {
      w = await makeWorld();
      const a = await approved(w);
      set(w);
      await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
      for (let i = 0; i < 6; i += 1)
        await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
      expect(w.paypal.count('capture')).toBe(1);
      await w.close();
    }
    w = await makeWorld();
  });
});

describe('double submit and replay (P10)', () => {
  it('double submit of placeOrder gives one order and one 409', async () => {
    w = await makeWorld();
    const approval = await w.approval();
    const input = { approval_id: approval.approval_id, token: approval.token, actor: BUYER_A };
    const [x, y] = await Promise.all([placeOrder(w.deps, input), placeOrder(w.deps, input)]);
    const oks = [x, y].filter((r) => r.ok);
    const errs = [x, y].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      ok: false,
      error: { code: 'approval', error: { code: 'already_used', http: 409 } },
    });
    expect(await count(w, 'orders')).toBe(1);
    expect(await count(w, 'operations')).toBe(1);
    expect(await count(w, 'entitlements')).toBe(1);
  });

  it('two approvals of the same content placed at once: one order, one order_open', async () => {
    w = await makeWorld();
    const a1 = await w.approval();
    const a2 = await w.approval();
    const [x, y] = await Promise.all([
      placeOrder(w.deps, { approval_id: a1.approval_id, token: a1.token, actor: BUYER_A }),
      placeOrder(w.deps, { approval_id: a2.approval_id, token: a2.token, actor: BUYER_A }),
    ]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect([x, y].filter((r) => !r.ok && r.error.code === 'order_open')).toHaveLength(1);
    expect(await count(w, 'orders')).toBe(1);
  });

  it('replaying a used token after the order exists gives no new order', async () => {
    w = await makeWorld();
    const p = await place(w);
    const r = await placeOrder(w.deps, {
      approval_id: p.approval.approval_id,
      token: p.approval.token,
      actor: BUYER_A,
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'approval', error: { code: 'already_used', http: 409 } },
    });
    expect(await count(w, 'orders')).toBe(1);
  });

  it('a tampered token is refused with 403 and no rows (every kind of tampering)', async () => {
    w = await makeWorld();
    const approval = await w.approval();
    const other = await w.approval({ offers: ['ofr_3'] });
    const tokens = [
      '',
      'x',
      approval.token + 'A',
      approval.token.slice(1),
      approval.token.toUpperCase() === approval.token
        ? approval.token.toLowerCase()
        : approval.token.toUpperCase(),
      other.token,
    ];
    for (const token of tokens) {
      const r = await placeOrder(w.deps, {
        approval_id: approval.approval_id,
        token,
        actor: BUYER_A,
      });
      expect(r).toMatchObject({ ok: false, error: { code: 'approval', error: { http: 403 } } });
    }
    expect(await count(w, 'orders')).toBe(0);
    expect(await count(w, 'order_units')).toBe(0);
    expect(await count(w, 'entitlements')).toBe(0);
    expect(await count(w, 'operations')).toBe(0);
    expect(await count(w, 'provider_orders')).toBe(0);
    expect(w.paypal.calls).toEqual([]);
  });

  it('the approval snapshot cannot be edited after the fact (immutable row), so the order still matches what the buyer approved', async () => {
    w = await makeWorld();
    const approval = await w.approval();
    // The approval row is immutable by trigger; the edit is attempted anyway and must not take.
    await expect(
      w.db.query(
        "UPDATE approvals SET snapshot = jsonb_set(snapshot, '{total_minor}', '1') WHERE id = $1",
        [approval.approval_id],
      ),
    ).rejects.toThrow();
    const r = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    expect(r.ok).toBe(true);
  });
});

describe('a PayPal call inside a transaction is detected and fails the test', () => {
  it('the spy throws and records a violation when a provider call is made inside a transaction', async () => {
    w = await makeWorld();
    await expect(
      w.db.transaction(async () => {
        await w.paypal.getOrder('SBXANY');
      }),
    ).rejects.toThrow(/inside a database transaction/);
    expect(w.paypal.violations).toEqual(['get']);
    // The spy did its job; clear it so the afterEach check does not fail this deliberate case.
    w.paypal.violations.length = 0;
  });

  it('a transaction that opened and closed before the call does not trip the spy', async () => {
    w = await makeWorld();
    await w.db.transaction(async (tx) => {
      await tx.query('SELECT 1');
    });
    await expect(w.paypal.getOrder('SBXANY')).resolves.toMatchObject({ kind: 'not_found' });
    expect(w.paypal.violations).toEqual([]);
  });

  it('the whole journey, with concurrent callers, never calls PayPal inside a transaction', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const b = await approved(w, { buyer_id: 'buy_B', actor: BUYER_B, offers: ['ofr_3'] });
    await Promise.all([
      onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A }),
      onBuyerReturn(w.deps, { order_ref: b.order_ref, actor: BUYER_B }),
      onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A }),
    ]);
    expect(w.paypal.violations).toEqual([]);
    expect(w.paypal.count('capture')).toBe(2);
  });
});

describe('cross-buyer access (P6, P13)', () => {
  it("buyer B cannot start, return or read buyer A's order; nothing is called", async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const calls = w.paypal.calls.length;
    expect(await beginCheckout(w.deps, { order_id: a.order_id, actor: BUYER_B })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_B })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(
      await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: { kind: 'system' } }),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(w.paypal.calls.length).toBe(calls);
  });

  it('a non-buyer actor cannot place an order', async () => {
    w = await makeWorld();
    const approval = await w.approval();
    const r = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: { kind: 'system' },
    });
    expect(r.ok).toBe(false);
    expect(await count(w, 'orders')).toBe(0);
  });
});
