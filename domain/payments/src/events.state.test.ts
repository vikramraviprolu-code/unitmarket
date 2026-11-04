// API-C (E1, E3 to E6, E8): the domain writes its events to the outbox in the same transaction as the
// change they describe. A paid order writes order.paid, entitlement.granted and sale.recorded, once each;
// a rolled-back transaction writes none; a refund that is booked writes refund.completed; a reconciler
// pass that did work writes settlement.completed. The domain only calls the EventOutbox port: this file
// injects a port that checks the payload against the v1 contract and inserts into event_outbox, as the
// adapter in apps/web does. Real PGlite, scripted PayPal, synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_SCHEMAS } from '@umsbx/contracts';
import type { EventOutbox, EventType } from '@umsbx/contracts';
import {
  applyReadback,
  executeRefund,
  onBuyerReturn,
  readApplyGates,
  requestRefund,
  runDue,
} from './index';
import { reapply } from './support';
import { OPERATOR, approved, makeWorld, paid, sentCapture } from './ops/support';
import type { OpsWorld } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

/** What the adapter of apps/web does: check the type and the payload, insert in the caller's transaction. */
function outboxFor(world: OpsWorld): EventOutbox {
  return {
    async append(tx, event) {
      const payload = EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
      const id = world.deps.ids.next('evt');
      await tx.query(
        'INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, $2, $3::jsonb, $4)',
        [id, event.type, JSON.stringify(payload), world.clock.now().toISOString()],
      );
      return id;
    },
  };
}
async function boot(price = 500, wired = true): Promise<void> {
  w = await makeWorld({ price });
  if (wired) w.deps.outbox = outboxFor(w);
}

interface Ev {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  occurred_at: string;
}
async function events(world: OpsWorld = w, type?: EventType): Promise<Ev[]> {
  const rows = await world.rows<{
    id: string;
    type: EventType;
    payload: unknown;
    occurred_at: Date;
  }>('SELECT id, type, payload, occurred_at FROM event_outbox ORDER BY occurred_at, id');
  return rows
    .map((r) => ({
      id: r.id,
      type: r.type,
      payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
        string,
        unknown
      >,
      occurred_at: new Date(r.occurred_at).toISOString(),
    }))
    .filter((e) => type === undefined || e.type === type);
}
const typesOf = async (): Promise<string[]> => (await events()).map((e) => e.type).sort();

describe('a paid order', () => {
  it('writes order.paid, entitlement.granted and sale.recorded once each, with ids and amounts only', async () => {
    await boot(500);
    const a = await paid(w);
    expect(await typesOf()).toEqual(['entitlement.granted', 'order.paid', 'sale.recorded']);

    const now = w.clock.now().toISOString();
    const order = (
      await w.rows<{ buyer_id: string; currency: string; total_minor: number | string }>(
        'SELECT buyer_id, currency, total_minor FROM orders WHERE id = $1',
        [a.order_id],
      )
    )[0]!;
    const unit = (
      await w.rows<{ id: string; publisher_id: string; amount_minor: number | string }>(
        'SELECT id, publisher_id, amount_minor FROM order_units WHERE order_id = $1',
        [a.order_id],
      )
    )[0]!;
    const ent = (
      await w.rows<{ id: string }>('SELECT id FROM entitlements WHERE unit_id = $1', [unit.id])
    )[0]!;

    const [orderPaid] = await events(w, 'order.paid');
    expect(orderPaid!.payload).toEqual({
      order_id: a.order_id,
      buyer_id: order.buyer_id,
      total: { currency: order.currency, minor: Number(order.total_minor) },
      paid_at: now,
    });
    const [granted] = await events(w, 'entitlement.granted');
    expect(granted!.payload).toEqual({
      entitlement_id: ent.id,
      order_id: a.order_id,
      buyer_id: order.buyer_id,
      unit_id: unit.id,
      granted_at: now,
    });
    const [sale] = await events(w, 'sale.recorded');
    expect(sale!.payload).toEqual({
      order_id: a.order_id,
      unit_id: unit.id,
      publisher_id: unit.publisher_id,
      gross: { currency: order.currency, minor: Number(unit.amount_minor) },
      recorded_at: now,
    });
    expect(Number(unit.amount_minor)).toBe(500);
  });

  it('stamps each event with the time it happened', async () => {
    await boot();
    const before = w.clock.now().toISOString();
    await paid(w);
    const all = await events();
    expect(all).toHaveLength(3);
    for (const e of all) expect(e.occurred_at).toBe(before);
  });

  it('the same read applied again (a webhook after the poll) writes nothing more', async () => {
    await boot();
    const a = await paid(w);
    const first = await events();
    await reapply(w, a.order_id, 'webhook');
    await reapply(w, a.order_id, 'poll');
    expect((await events()).map((e) => e.id)).toEqual(first.map((e) => e.id));
  });

  it('a payment that is still pending writes none of the three', async () => {
    await boot();
    // PayPal answers PENDING: nothing is verified, nothing is booked, nobody is paid
    w.paypal.next.status = 'PENDING';
    const a = await approved(w);
    await onBuyerReturn(w.deps, {
      order_ref: a.order_ref,
      actor: { kind: 'buyer', buyer_id: 'buy_A' },
    });
    expect(await typesOf()).toEqual([]);
  });

  it('writes nothing at all when no outbox is wired (the domain works without it)', async () => {
    await boot(500, false);
    await paid(w);
    expect(await events()).toEqual([]);
  });

  it('two items of one order write one order.paid and one sale.recorded per unit', async () => {
    await boot();
    const a = await paid(w, { offers: ['ofr_1', 'ofr_2'] });
    expect(await events(w, 'order.paid')).toHaveLength(1);
    const units = await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [
      a.order_id,
    ]);
    const sales = await events(w, 'sale.recorded');
    expect(sales.map((s) => s.payload['unit_id']).sort()).toEqual(units.map((u) => u.id).sort());
    const ents = await w.rows<{ id: string }>('SELECT id FROM entitlements');
    const granted = await events(w, 'entitlement.granted');
    expect(granted.map((g) => g.payload['entitlement_id']).sort()).toEqual(
      ents.map((e) => e.id).sort(),
    );
  });
});

describe('same transaction', () => {
  it('a rolled-back transaction writes no event, and the order stays unpaid', async () => {
    await boot();
    const a = await sentCapture(w);
    const read = await w.paypal.getOrder(a.provider_order_id);
    if (read.kind !== 'order') throw new Error('no read');
    const gates = await readApplyGates(w.deps, a.order_id);
    await expect(
      w.db.transaction(async (tx) => {
        await applyReadback(tx, w.deps, { order_id: a.order_id, read, trigger: 'poll', gates });
        // the events are in this transaction now ...
        const inside = await tx.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM event_outbox',
        );
        expect(Number(inside.rows[0]!.n)).toBe(3);
        throw new Error('the caller failed after the apply');
      }),
    ).rejects.toThrow('the caller failed');
    // ... and gone with it
    expect(await events()).toEqual([]);
    expect(
      (
        await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [a.order_id])
      )[0]!.status,
    ).not.toBe('paid');
  });

  it('the same apply, committed, writes the three events; then a second one writes nothing', async () => {
    await boot();
    const a = await sentCapture(w);
    await reapply(w, a.order_id);
    expect(await typesOf()).toEqual(['entitlement.granted', 'order.paid', 'sale.recorded']);
    await reapply(w, a.order_id);
    expect(await typesOf()).toEqual(['entitlement.granted', 'order.paid', 'sale.recorded']);
  });

  it('a payload the contract refuses stops the transaction instead of being written half', async () => {
    await boot();
    w.deps.outbox = {
      append: () =>
        Promise.reject(new Error('event payload does not match the sale.recorded schema')),
    };
    const a = await sentCapture(w);
    await expect(reapply(w, a.order_id)).rejects.toThrow(/event payload/);
    expect(
      (
        await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [a.order_id])
      )[0]!.status,
    ).not.toBe('paid');
    expect(await w.rows('SELECT 1 FROM ledger_entries')).toEqual([]);
  });
});

describe('refund.completed', () => {
  // `w` is this world too, so the file's afterEach checks and closes it.
  let r: RemainingWorld;
  async function bootRefund(): Promise<{ unit_id: string; order_id: string }> {
    r = await makeRemainingWorld({ price: 500 });
    w = r;
    r.deps.outbox = outboxFor(r);
    const a = await paid(r);
    const unit = (
      await r.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!;
    return { unit_id: unit.id, order_id: a.order_id };
  }
  const refund = async (unit_id: string, minor: number | null): Promise<string> => {
    const rq = await requestRefund(r.deps, {
      unit_id,
      amount: minor === null ? null : { currency: 'USD', minor },
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!rq.ok) throw new Error(`refused: ${rq.error.code}`);
    await executeRefund(r.deps, { refund_request_id: rq.value.refund_request_id });
    return rq.value.refund_request_id;
  };

  it('a full refund writes one refund.completed with the refund id, the unit and the amount', async () => {
    const { unit_id, order_id } = await bootRefund();
    await refund(unit_id, null);
    const got = await events(r, 'refund.completed');
    expect(got).toHaveLength(1);
    const ledger = (
      await r.rows<{ refund_id: string; amount_minor: number | string }>(
        "SELECT refund_id, amount_minor FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund'",
        [unit_id],
      )
    )[0]!;
    const publisher = (
      await r.rows<{ publisher_id: string }>('SELECT publisher_id FROM order_units WHERE id = $1', [
        unit_id,
      ])
    )[0]!;
    expect(got[0]!.payload).toEqual({
      refund_id: ledger.refund_id,
      order_id,
      unit_id,
      publisher_id: publisher.publisher_id,
      amount: { currency: 'USD', minor: 500 },
      completed_at: r.clock.now().toISOString(),
    });
    expect(Number(ledger.amount_minor)).toBe(500);
  });

  it('a partial refund writes one per booked refund, with its own amount', async () => {
    const { unit_id } = await bootRefund();
    await refund(unit_id, 200);
    await refund(unit_id, 300);
    const got = await events(r, 'refund.completed');
    expect(got.map((e) => (e.payload['amount'] as { minor: number }).minor).sort()).toEqual([
      200, 300,
    ]);
    expect(new Set(got.map((e) => e.payload['refund_id'])).size).toBe(2);
  });

  it('a read of the same refund again (a replay) writes nothing more', async () => {
    const { unit_id } = await bootRefund();
    await refund(unit_id, null);
    expect(await events(r, 'refund.completed')).toHaveLength(1);
    await runDue(r.deps, { max_items: 10 });
    await reapply(
      r,
      (
        await r.rows<{ order_id: string }>('SELECT order_id FROM order_units WHERE id = $1', [
          unit_id,
        ])
      )[0]!.order_id,
    );
    expect(await events(r, 'refund.completed')).toHaveLength(1);
  });

  it('a refund that is requested but not completed writes nothing', async () => {
    const { unit_id } = await bootRefund();
    r.refundNext.status = 'PENDING';
    await refund(unit_id, null);
    expect(await events(r, 'refund.completed')).toEqual([]);
  });
});

describe('settlement.completed', () => {
  it('a reconciler pass that did work writes one, with the counts checked and fixed', async () => {
    await boot();
    const a = await sentCapture(w);
    w.tick(61_000);
    const counts = await runDue(w.deps, { max_items: 10 });
    expect(counts.processed).toBe(1);
    const got = await events(w, 'settlement.completed');
    expect(got).toHaveLength(1);
    expect(got[0]!.payload).toEqual({
      pass_id: expect.stringMatching(/^pas_[0-9a-z]{26}$/),
      checked: 1,
      fixed: 1,
      completed_at: w.clock.now().toISOString(),
    });
    // the pass is the cause of the payment being booked, so the other events come with it
    expect(await typesOf()).toEqual([
      'entitlement.granted',
      'order.paid',
      'sale.recorded',
      'settlement.completed',
    ]);
    void a;
  });

  it('counts an item the pass could not settle as checked, not fixed', async () => {
    await boot();
    await sentCapture(w);
    // PayPal cannot be read this pass: the item stays unknown
    w.paypal.queue.get.push({ kind: 'timeout' });
    w.tick(61_000);
    const counts = await runDue(w.deps, { max_items: 10 });
    expect(counts.processed).toBe(1);
    expect(counts.still_unknown).toBe(1);
    const [e] = await events(w, 'settlement.completed');
    expect(e!.payload).toMatchObject({ checked: 1, fixed: 0 });
  });

  it('an idle pass writes nothing, and a pass with the outbound switch off writes nothing', async () => {
    await boot();
    expect(await runDue(w.deps, { max_items: 10 })).toEqual({
      processed: 0,
      still_unknown: 0,
      expired: 0,
      abandoned: 0,
    });
    expect(await events()).toEqual([]);
    await sentCapture(w);
    w.switches.paypal_outbound = false;
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await events(w, 'settlement.completed')).toEqual([]);
  });

  it('every pass that does work writes its own, with its own pass id', async () => {
    await boot();
    await sentCapture(w);
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    await sentCapture(w, { buyer_id: 'buy_B' });
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    const got = await events(w, 'settlement.completed');
    expect(got).toHaveLength(2);
    expect(new Set(got.map((e) => e.payload['pass_id'])).size).toBe(2);
  });

  it('writes nothing when no outbox is wired', async () => {
    await boot(500, false);
    await sentCapture(w);
    w.tick(61_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await events()).toEqual([]);
  });
});
