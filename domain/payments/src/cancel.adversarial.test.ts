// ORDER-A (docs/specs/order-a-cancel-resume.md): a buyer cancel must never abandon an order that could
// still be paid, and must never reveal or touch another buyer's order. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent } from '@umsbx/contracts';
import { cancelOrder, checkInvariants, handleWebhook, onBuyerReturn } from './index';
import {
  BUYER_A,
  BUYER_B,
  OPERATOR,
  approvePo,
  approved,
  awaiting,
  count,
  makeWorld,
  orderStatus,
  paid,
  place,
} from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';
import { insertOperation } from './store';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const PACK = { offers: ['ofr_1', 'ofr_3'] };
const actor = BUYER_A;
const cancel = (
  a: Pick<Awaiting, 'order_id'> | { order_id: string },
  who: Parameters<typeof cancelOrder>[1]['actor'] = actor,
) => cancelOrder(w.deps, { order_id: a.order_id, actor: who });
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
const invariantsFailing = async (): Promise<string[]> =>
  (await checkInvariants(w.db)).filter((r) => !r.ok).map((r) => r.id);
/** Nothing about the order moved. */
async function untouched(
  a: Awaiting,
  status: string,
  pos: string[],
  units: string[],
): Promise<void> {
  expect(await orderStatus(w, a.order_id)).toBe(status);
  expect(await poStates(a.order_id)).toEqual(pos);
  expect(await unitStates(a.order_id)).toEqual(units);
  expect(await invariantsFailing()).toEqual([]);
}

describe('who may cancel', () => {
  it('another buyer gets not_found, reads nothing at PayPal and changes nothing', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const r = await cancel(a, BUYER_B);
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(w.paypal.count('get')).toBe(0);
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });

  it('an operator, a publisher and the system are not buyers: not_found', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    for (const who of [
      OPERATOR,
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'system' },
    ] as const) {
      expect(await cancel(a, who as never)).toEqual({ ok: false, error: { code: 'not_found' } });
    }
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });

  it('a guessed or malformed id is not_found, the same answer as another buyer gets', async () => {
    w = await makeWorld();
    await awaiting(w);
    for (const id of ['ord_doesnotexist', 'x', '', 'ord_\u0000nul', 'a'.repeat(500)]) {
      expect(await cancel({ order_id: id })).toEqual({ ok: false, error: { code: 'not_found' } });
    }
    expect(w.paypal.count('get')).toBe(0);
  });
});

describe('statuses that are not awaiting_buyer', () => {
  it('a paid order is wrong_state and nothing changes (the payment stays)', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const ledger = await count(w, 'ledger_entries');
    expect(ledger).toBeGreaterThan(0);
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries')).toBe(ledger);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('an order whose checkout has not begun (created) is wrong_state', async () => {
    w = await makeWorld();
    const p = await place(w);
    expect(await cancel(p)).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect(await orderStatus(w, p.order_id)).toBe('created');
    expect(w.paypal.count('get')).toBe(0);
  });

  it('frozen and failed orders are wrong_state', async () => {
    w = await makeWorld();
    for (const status of ['frozen', 'failed'] as const) {
      const a = await awaiting(w, { buyer_id: 'buy_A' });
      await w.rows('UPDATE orders SET status = $2 WHERE id = $1', [a.order_id, status]);
      expect(await cancel(a)).toEqual({ ok: false, error: { code: 'wrong_state' } });
      expect(await orderStatus(w, a.order_id)).toBe(status);
      await w.rows("UPDATE orders SET status = 'abandoned' WHERE id = $1", [a.order_id]);
    }
  });
});

describe('a payment that has started or could still capture is never cancelled', () => {
  it('approved here (the buyer returned): payment_started, no read, nothing changes', async () => {
    w = await makeWorld();
    const a = await approved(w);
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    expect(w.paypal.count('get')).toBe(0);
    await untouched(a, 'awaiting_buyer', ['approved'], ['expected']);
  });

  it('approved at PayPal but not yet seen here: the read shows APPROVED, payment_started', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    approvePo(w, a);
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    expect(w.paypal.count('capture')).toBe(0);
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });

  it('PayPal shows a capture already on the order: payment_started, not abandoned, not captured again', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    approvePo(w, a);
    await w.paypal.captureOrder({
      provider_order_id: a.provider_order_id,
      request_id: 'oob-key',
      scenario: null,
    });
    const captures = w.paypal.count('capture');
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    expect(w.paypal.count('capture')).toBe(captures);
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });

  it('a PayPal order in any status but CREATED or VOIDED (payer action required) is payment_started', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.paypal.orders.get(a.provider_order_id)!.status = 'PAYER_ACTION_REQUIRED';
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });

  it('a capture operation that was sent or is unknown blocks the cancel under the lock', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const at = w.clock.now().toISOString();
    const later = new Date(w.clock.now().getTime() + 2 * H).toISOString();
    const po = (
      await w.rows<{ id: string }>('SELECT id FROM provider_orders WHERE order_id = $1', [
        a.order_id,
      ])
    )[0]!;
    await w.db.transaction((tx) =>
      insertOperation(tx, {
        id: w.deps.ids.next('opr'),
        order_id: a.order_id,
        kind: 'capture',
        state: 'unknown',
        request_id: `umsK-${a.order_ref}-x`,
        lease_until: null,
        reconcile_until: later,
        next_retry_at: later,
        at,
        provider_order_ref: po.id,
      }),
    );
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });

  it('a pack with one PayPal order approved: payment_started, no PayPal order abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    await w.rows(
      "UPDATE provider_orders SET state = 'approved', status = 'APPROVED', first_approved_at = $2 WHERE order_id = $1 AND position = 1",
      [a.order_id, w.clock.now().toISOString()],
    );
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    await untouched(a, 'awaiting_buyer', ['approved', 'awaiting_buyer'], ['expected', 'expected']);
  });

  it('a pack with one PayPal order captured: refused, the captured part stays paid', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    const ret = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor });
    expect(ret.ok).toBe(true);
    const before = await poStates(a.order_id);
    expect(before).toContain('captured');
    const r = await cancel(a);
    expect(r.ok).toBe(false);
    expect(await poStates(a.order_id)).toEqual(before);
    expect(await invariantsFailing()).toEqual([]);
  });
});

describe('PayPal cannot be read, or payments are switched off: fail closed', () => {
  it('a timeout on the read is unavailable and nothing changes', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.paypal.queue.get.push({ kind: 'timeout' });
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'unavailable' } });
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
    // and a retry once PayPal answers works
    expect((await cancel(a)).ok).toBe(true);
  });

  it('the outbound switch off is unavailable, with no read', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    w.switches.paypal_outbound = false;
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'unavailable' } });
    expect(w.paypal.count('get')).toBe(0);
    await untouched(a, 'awaiting_buyer', ['awaiting_buyer'], ['expected']);
  });
});

describe('races', () => {
  it('the buyer returns and pays between our read and our lock: the cancel loses, the payment stands', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    // Our read happens first (it shows CREATED); then, before the lock, the buyer approves and returns.
    w.paypal.beforeGet = null;
    const real = w.paypal.getOrder.bind(w.paypal);
    let raced = false;
    w.paypal.getOrder = async (id) => {
      const read = await real(id);
      if (!raced) {
        raced = true;
        approvePo(w, a);
        await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor });
      }
      return read;
    };
    const r = await cancel(a);
    expect(r.ok).toBe(false);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
    expect(await unitStates(a.order_id)).toEqual(['captured_verified']);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('a return marks the PayPal order approved between our read and our lock: payment_started, nothing abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const real = w.paypal.getOrder.bind(w.paypal);
    w.paypal.getOrder = async (id) => {
      const read = await real(id);
      await w.rows(
        "UPDATE provider_orders SET state = 'approved', status = 'APPROVED', first_approved_at = $2 WHERE order_id = $1",
        [a.order_id, w.clock.now().toISOString()],
      );
      return read;
    };
    expect(await cancel(a)).toEqual({ ok: false, error: { code: 'payment_started' } });
    await untouched(a, 'awaiting_buyer', ['approved'], ['expected']);
  });

  it('two cancels at once: one abandons, the other is the idempotent answer, one audit row at most', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const [x, y] = await Promise.all([cancel(a), cancel(a)]);
    const oks = [x, y].filter((r) => r.ok);
    expect(oks.length).toBe(2);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await unitStates(a.order_id)).toEqual(['declined']);
    expect(await invariantsFailing()).toEqual([]);
  });

  it('a webhook that arrives before the cancel does not move an awaiting order; the cancel still reads PayPal', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const e: ProviderEvent = {
      event_id: 'WH-EVT-C1',
      transmission_id: 'tx-c1',
      type: 'CHECKOUT.ORDER.APPROVED',
      provider_order_id: a.provider_order_id,
      capture_id: null,
      refund_id: null,
      occurred_at: w.clock.now().toISOString(),
    };
    await handleWebhook(w.deps, {
      verdict: { kind: 'verified', event: e },
      transmission_id: e.transmission_id,
      received_at: e.occurred_at,
    });
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect((await cancel(a)).ok).toBe(true); // PayPal still shows CREATED: nothing was approved
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
  });

  it('a webhook that arrives after the cancel starts no read-back and captures nothing', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    await cancel(a);
    const ops = await count(w, 'operations');
    const e: ProviderEvent = {
      event_id: 'WH-EVT-C2',
      transmission_id: 'tx-c2',
      type: 'CHECKOUT.ORDER.APPROVED',
      provider_order_id: a.provider_order_id,
      capture_id: null,
      refund_id: null,
      occurred_at: w.clock.now().toISOString(),
    };
    await handleWebhook(w.deps, {
      verdict: { kind: 'verified', event: e },
      transmission_id: e.transmission_id,
      received_at: e.occurred_at,
    });
    expect(await count(w, 'operations')).toBe(ops);
    expect(w.paypal.count('capture')).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await invariantsFailing()).toEqual([]);
  });
});
