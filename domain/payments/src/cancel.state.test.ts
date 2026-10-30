// ORDER-A (docs/specs/order-a-cancel-resume.md): a buyer cancels an unpaid order through the existing
// abandon transition. State tests over the real engine: real PGlite, scripted PayPal. The money rules of
// capture, refund and webhook are not touched; these tests pin that cancel reuses the abandon result and
// leaves the ledger, the invariants and the sweep as they were.
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@umsbx/contracts';
import { beginCheckout, cancelOrder, checkInvariants, onBuyerReturn, runDue } from './index';
import { BUYER_A, approvePo, awaiting, count, makeWorld, orderStatus, place } from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;
const PACK = { offers: ['ofr_1', 'ofr_3'] };

/** The world with an audit sink that really writes audit_log rows (the world's own sink is a no-op). */
async function world(): Promise<void> {
  w = await makeWorld();
  let n = 0;
  w.deps = {
    ...w.deps,
    audit: {
      record: async (tx: SqlExecutor, e) => {
        n += 1;
        const at = w.clock.now().toISOString();
        await tx.query(
          `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
          [
            `aud_c${n}`,
            e.actor.kind,
            e.actor.kind === 'buyer' ? e.actor.buyer_id : null,
            e.action,
            e.target,
            e.reason,
            JSON.stringify(e.detail),
            at,
          ],
        );
      },
    },
  };
}
const auditRows = (): Promise<
  { actor_kind: string; actor_id: string | null; action: string; target: string }[]
> =>
  w.rows(
    `SELECT actor_kind, actor_id, action, target FROM audit_log WHERE action = 'order.cancelled_by_buyer' ORDER BY id`,
  );
const poStates = async (order_id: string): Promise<string[]> =>
  (
    await w.rows<{ state: string }>(
      'SELECT state FROM provider_orders WHERE order_id = $1 ORDER BY position',
      [order_id],
    )
  ).map((r) => r.state);
const unitStates = async (order_id: string): Promise<string[]> =>
  (
    await w.rows<{ status: string }>(
      'SELECT status FROM order_units WHERE order_id = $1 ORDER BY id',
      [order_id],
    )
  ).map((r) => r.status);
const money = async (order_id: string): Promise<string[]> =>
  (
    await w.rows<{ money_state: string }>(
      `SELECT e.money_state FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1 ORDER BY e.id`,
      [order_id],
    )
  ).map((r) => r.money_state);
const cancel = (a: Pick<Awaiting, 'order_id'>, actor = BUYER_A) =>
  cancelOrder(w.deps, { order_id: a.order_id, actor });
const invariantsFailing = async (): Promise<string[]> =>
  (await checkInvariants(w.db)).filter((r) => !r.ok).map((r) => r.id);

describe('a buyer cancels an unpaid order', () => {
  it('abandons it like the sweep does: units declined, access denied, nothing captured, no ledger row, invariants hold', async () => {
    await world();
    const a = await awaiting(w);
    const ledgerBefore = await count(w, 'ledger_entries');
    const r = await cancel(a);
    expect(r).toEqual({
      ok: true,
      value: { order_ref: a.order_ref, status: 'abandoned', already: false },
    });
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await poStates(a.order_id)).toEqual(['abandoned']);
    expect(await unitStates(a.order_id)).toEqual(['declined']);
    expect(await money(a.order_id)).toEqual(['denied']);
    expect(w.paypal.count('capture')).toBe(0);
    expect(w.paypal.count('get')).toBe(1); // the one read that proves nothing was approved
    expect(await count(w, 'ledger_entries')).toBe(ledgerBefore);
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('writes one audit row that names the buyer as the actor', async () => {
    await world();
    const a = await awaiting(w);
    await cancel(a);
    expect(await auditRows()).toEqual([
      {
        actor_kind: 'buyer',
        actor_id: 'buy_A',
        action: 'order.cancelled_by_buyer',
        target: a.order_id,
      },
    ]);
  });

  it('is idempotent: a second cancel is ok with already true, reads nothing, writes no second audit row', async () => {
    await world();
    const a = await awaiting(w);
    await cancel(a);
    const reads = w.paypal.count('get');
    const again = await cancel(a);
    expect(again).toEqual({
      ok: true,
      value: { order_ref: a.order_ref, status: 'abandoned', already: true },
    });
    expect(w.paypal.count('get')).toBe(reads);
    expect((await auditRows()).length).toBe(1);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('an order the sweep already abandoned answers ok with already true', async () => {
    await world();
    const a = await awaiting(w);
    w.tick(DAY + 1000);
    expect((await runDue(w.deps, { max_items: 10 })).abandoned).toBe(1);
    const r = await cancel(a);
    expect(r).toEqual({
      ok: true,
      value: { order_ref: a.order_ref, status: 'abandoned', already: true },
    });
    expect(await auditRows()).toEqual([]); // nothing new happened
  });

  it('a cancelled order is not abandoned a second time by the sweep, and is not read again', async () => {
    await world();
    const a = await awaiting(w);
    await cancel(a);
    const reads = w.paypal.count('get');
    w.tick(DAY + 1000);
    expect(await runDue(w.deps, { max_items: 10 })).toEqual({
      processed: 0,
      still_unknown: 0,
      expired: 0,
      abandoned: 0,
    });
    expect(w.paypal.count('get')).toBe(reads);
  });

  it('cancels a whole pack: every PayPal order abandoned, every unit declined', async () => {
    await world();
    const a = await awaiting(w, PACK);
    expect(a.provider_orders.length).toBe(2);
    const r = await cancel(a);
    expect(r.ok).toBe(true);
    expect(await poStates(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect(await unitStates(a.order_id)).toEqual(['declined', 'declined']);
    expect(w.paypal.count('get')).toBe(2);
    expect(w.paypal.count('capture')).toBe(0);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('cancels when PayPal no longer knows the order (not found): nothing can capture', async () => {
    await world();
    const a = await awaiting(w);
    expect(w.paypal.orders.delete(a.provider_order_id)).toBe(true);
    const r = await cancel(a);
    expect(r.ok).toBe(true);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
  });

  it('a late approval at PayPal and a return after the cancel capture nothing', async () => {
    await world();
    const a = await awaiting(w);
    await cancel(a);
    approvePo(w, a); // the buyer finishes the PayPal page in an old tab
    const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    expect(r.ok && r.value.status).toBe('abandoned');
    expect(w.paypal.count('capture')).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('after a cancel the checkout cannot be resumed (wrong_state), and a new order can be placed', async () => {
    await world();
    const a = await awaiting(w);
    await cancel(a);
    const c = await beginCheckout(w.deps, { order_id: a.order_id, actor: BUYER_A });
    expect(c).toEqual({ ok: false, error: { code: 'wrong_state' } });
    const again = await awaiting(w);
    expect(again.order_id).not.toBe(a.order_id);
  });
});

describe('resume: the existing checkout answers an awaiting order with its stored link', () => {
  it('gives the same approve link, creates no further PayPal order and no new operation', async () => {
    await world();
    const a = await awaiting(w);
    const creates = w.paypal.count('create');
    const ops = await count(w, 'operations');
    const c = await beginCheckout(w.deps, { order_id: a.order_id, actor: BUYER_A });
    expect(c.ok && c.value.approve_url).toBe(a.approve_url);
    expect(w.paypal.count('create')).toBe(creates);
    expect(await count(w, 'operations')).toBe(ops);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });

  it('a created order that never went to PayPal can still start its checkout', async () => {
    await world();
    const p = await place(w);
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c.ok).toBe(true);
  });
});
