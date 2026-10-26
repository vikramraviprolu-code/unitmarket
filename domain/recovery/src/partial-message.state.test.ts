// DP-3 (MVP-D, OQ-7, OQ-8): what the buyer of a partial pack reads, and how the case closes. A pack is
// one order with two units on two PayPal orders (provider_orders rows, one per publisher). The
// wording is the owner's OQ-8 text with the titles of the case's own order: "not charged" is said only
// of a PayPal order that was declined, failed or abandoned, never of a frozen one (that is "on hold").
// Keep-what-worked is the default by doing nothing; a refund is the operator's, through the existing
// MFA route, and the case closes with close_no_fault (never offer_refund). No recovery path creates an
// order, quote, proposal or approval (D-03). The refund route itself (requestRefund, executeRefund) is
// payments' and is proven in domain/payments/src/refunds.composite.state.test.ts: recovery never
// imports payments, so this file sets the refund rows it reads by hand.
// Real PGlite, synthetic rows only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyAutomaticRules, listCasesForBuyer, openCase, resolve } from './index';
import { makeWorld } from './world';
import type { World } from './world';

const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;
const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;
const buyer2 = { kind: 'buyer', buyer_id: 'buy_2' } as const;

const HARBOUR = 'Harbour Ledger Guide';
const QUAYSIDE = 'Quayside Tide Tables';
const GENERIC_HOLD =
  'Your order is on hold while we check it. You have not been charged twice. We will write to you.';
const GENERIC_PARTIAL =
  'Part of your order did not complete. We are checking it and will write to you.';

let w: World;
beforeAll(async () => {
  w = await makeWorld('pm');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set('2026-10-21T10:00:00.000Z');
});

type PoState = 'captured' | 'declined' | 'failed' | 'abandoned' | 'frozen';
const UNIT_OF: Record<PoState, string> = {
  captured: 'captured_verified',
  declined: 'declined',
  failed: 'expected',
  abandoned: 'expected',
  frozen: 'mismatch',
};
/**
 * One order of two units: unit 1 (publisher 1, "Harbour") on PayPal order 1, unit 2 (publisher 2,
 * "Quayside") on PayPal order 2. `second` is the state of PayPal order 2; PayPal order 1 is captured.
 */
async function pack(second: PoState, o: { quaysideTitle?: string } = {}): Promise<void> {
  await w.item(1, { title: HARBOUR });
  await w.item(2, {
    title: o.quaysideTitle ?? QUAYSIDE,
    unit_status: UNIT_OF[second],
  });
  await w.insert('publishers', {
    id: 'pub_2',
    slug: 'p2',
    display_name: 'Pub Two',
    country: 'US',
    paypal_merchant_id: 'MERCH2',
    payee_verified_at: w.clock.now().toISOString(),
  });
  // unit 2 joins order 1; the order the helper made for it is removed
  await w.db.query(
    "UPDATE order_units SET order_id = 'ord_1', publisher_id = 'pub_2' WHERE id = 'unt_2'",
  );
  await w.db.query("DELETE FROM orders WHERE id = 'ord_2'");
  for (const [k, state] of [
    [1, 'captured'],
    [2, second],
  ] as const) {
    await w.insert('provider_orders', {
      id: `pvo_${k}`,
      order_id: 'ord_1',
      provider_order_id: `PAYPALPO${k}`,
      route: 'per_publisher',
      approve_url: null,
      status: null,
      position: k,
      po_ref: `ref_1-p${k}`,
      publisher_id: `pub_${k}`,
      state,
      first_approved_at: null,
    });
    await w.db.query('UPDATE order_units SET provider_order_ref = $2 WHERE id = $1', [
      `unt_${k}`,
      `pvo_${k}`,
    ]);
  }
  await w.db.query("UPDATE orders SET status = 'paid_partial', mismatch = $1 WHERE id = 'ord_1'", [
    second === 'frozen',
  ]);
}
const alertFor = (kind: 'partial_composite' | 'frozen_order') =>
  kind === 'partial_composite'
    ? w.rawAlert({ kind, order_id: 'ord_1', reason: 'partial' })
    : w.rawAlert({ kind, order_id: 'ord_1', unit_id: 'unt_2', reason: 'unit_payee_merchant_id' });
const run = () => applyAutomaticRules(w.deps, { max_items: 20 });
const casesOf = async (kind?: string) =>
  (await listCasesForBuyer(w.db, { buyer_id: 'buy_1' })).filter(
    (c) => kind === undefined || c.kind === kind,
  );
const noInternals = (text: string): void => {
  for (const bad of ['unt_', 'art_', 'pvo_', 'ord_', 'ref_1', 'PAYPALPO', 'MERCH', 'CAP', 'alr_']) {
    expect(text).not.toContain(bad);
  }
};

describe('the partial message (OQ-8)', () => {
  it.each(['declined', 'failed', 'abandoned'] as const)(
    'paid_partial with PO2 %s: one case, message names the ready title and the not-charged title',
    async (second) => {
      await pack(second);
      await alertFor('partial_composite');
      expect(await run()).toEqual({ opened: 1, restored: 0 });
      const found = await casesOf('partial_composite');
      expect(found).toHaveLength(1);
      expect(found[0]?.buyer_message).toBe(
        `Part of your order did not go through. ${HARBOUR} is ready in your library. You were not charged for ${QUAYSIDE}. If you would rather have a refund for what you paid, tell us on the help page.`,
      );
      expect(found[0]?.state).toBe('open');
      expect(found[0]?.opened_by).toBe('system');
      noInternals(found[0]!.buyer_message);
    },
  );

  it('paid_partial with PO2 frozen: no partial_composite case; the frozen_order message names the held title as on hold and the ready title as ready, never "not charged"', async () => {
    await pack('frozen');
    await alertFor('frozen_order'); // payments raises this one, and no partial_composite alert
    expect(await run()).toEqual({ opened: 1, restored: 0 });
    expect(await casesOf('partial_composite')).toEqual([]);
    const found = await casesOf('frozen_order');
    expect(found).toHaveLength(1);
    expect(found[0]?.buyer_message).toBe(
      `${QUAYSIDE} is on hold while we check it. ${HARBOUR} is ready in your library.`,
    );
    expect(found[0]?.buyer_message.toLowerCase()).not.toContain('not charged');
    noInternals(found[0]!.buyer_message);
  });

  it('a partial_composite alert on an order that only has a held PayPal order never says "not charged"', async () => {
    await pack('frozen');
    await alertFor('partial_composite'); // should not happen; the message must still not lie
    await run();
    const found = await casesOf('partial_composite');
    expect(found).toHaveLength(1);
    expect(found[0]?.buyer_message.toLowerCase()).not.toContain('not charged');
    expect(found[0]?.buyer_message).toBe(GENERIC_PARTIAL);
  });

  it('frozen order with nothing ready keeps the whole-order hold text', async () => {
    await w.item(1, { title: HARBOUR, unit_status: 'mismatch' });
    await w.insert('provider_orders', {
      id: 'pvo_1',
      order_id: 'ord_1',
      provider_order_id: 'PAYPALPO1',
      route: 'single',
      approve_url: null,
      status: null,
      position: 1,
      po_ref: 'ref_1',
      publisher_id: null,
      state: 'frozen',
      first_approved_at: null,
    });
    await w.db.query("UPDATE order_units SET provider_order_ref = 'pvo_1' WHERE id = 'unt_1'");
    await w.db.query("UPDATE orders SET status = 'frozen', mismatch = true WHERE id = 'ord_1'");
    await w.rawAlert({
      kind: 'frozen_order',
      order_id: 'ord_1',
      unit_id: 'unt_1',
      reason: 'unit_x',
    });
    await run();
    expect((await casesOf('frozen_order'))[0]?.buyer_message).toBe(GENERIC_HOLD);
  });

  it('a frozen order with no PayPal order rows at all keeps the whole-order hold text', async () => {
    await w.item(1, { unit_status: 'mismatch' });
    await w.rawAlert({ kind: 'frozen_order', order_id: 'ord_1', reason: 'unit_x' });
    await run();
    expect((await casesOf('frozen_order'))[0]?.buyer_message).toBe(GENERIC_HOLD);
  });

  it('a frozen order whose held PayPal order is the one that paid (a refund list froze it) keeps the whole-order hold text', async () => {
    await w.item(1, { title: HARBOUR });
    await w.insert('provider_orders', {
      id: 'pvo_1',
      order_id: 'ord_1',
      provider_order_id: 'PAYPALPO1',
      route: 'single',
      approve_url: null,
      status: null,
      position: 1,
      po_ref: 'ref_1',
      publisher_id: null,
      state: 'captured',
      first_approved_at: null,
    });
    await w.db.query("UPDATE order_units SET provider_order_ref = 'pvo_1' WHERE id = 'unt_1'");
    await w.db.query("UPDATE orders SET mismatch = true WHERE id = 'ord_1'");
    await w.rawAlert({
      kind: 'frozen_order',
      order_id: 'ord_1',
      unit_id: 'unt_1',
      reason: 'refund_list_x',
    });
    await run();
    expect((await casesOf('frozen_order'))[0]?.buyer_message).toBe(GENERIC_HOLD);
  });

  it('several ready titles are joined and agree with "are"', async () => {
    await pack('declined');
    await w.item(3, { title: 'Second Harbour Piece' });
    await w.db.query(
      "UPDATE order_units SET order_id = 'ord_1', provider_order_ref = 'pvo_1' WHERE id = 'unt_3'",
    );
    await w.db.query("DELETE FROM orders WHERE id = 'ord_3'");
    await alertFor('partial_composite');
    await run();
    expect((await casesOf('partial_composite'))[0]?.buyer_message).toBe(
      `Part of your order did not go through. ${HARBOUR} and Second Harbour Piece are ready in your library. You were not charged for ${QUAYSIDE}. If you would rather have a refund for what you paid, tell us on the help page.`,
    );
  });

  it('a title is one clean line of at most 80 characters in the message', async () => {
    await pack('declined', { quaysideTitle: `  Tide\n\ttables   ${'x'.repeat(200)} ` });
    await alertFor('partial_composite');
    await run();
    const msg = (await casesOf('partial_composite'))[0]!.buyer_message;
    expect(msg).not.toMatch(/[\n\t]/);
    expect(msg).toContain('You were not charged for Tide tables xxx');
    const named = /You were not charged for (.*)\. If you/.exec(msg)?.[1] ?? '';
    expect(named.length).toBeLessThanOrEqual(83); // 80 characters and an ellipsis
  });

  it('a ready item that was refunded is not called ready; with nothing ready the generic text is kept', async () => {
    await pack('declined');
    await w.db.query(
      "UPDATE order_units SET status = 'refunded', refunded_minor = amount_minor WHERE id = 'unt_1'",
    );
    await alertFor('partial_composite');
    await run();
    expect((await casesOf('partial_composite'))[0]?.buyer_message).toBe(GENERIC_PARTIAL);
  });

  it('a second rule pass opens nothing', async () => {
    await pack('declined');
    await alertFor('partial_composite');
    expect((await run()).opened).toBe(1);
    expect(await run()).toEqual({ opened: 0, restored: 0 });
    expect(await casesOf()).toHaveLength(1);
    expect(await w.count('recovery_cases')).toBe(1);
  });
});

describe('keep is the default, a refund is the help-page report and the operator (OQ-7)', () => {
  it('D-03: across open, rule and resolve, the counts of orders, quotes, proposals and approvals do not change', async () => {
    await pack('declined');
    const counts = async () => ({
      orders: await w.count('orders'),
      quotes: await w.count('quotes'),
      proposals: await w.count('proposals'),
      approvals: await w.count('approvals'),
      units: await w.count('order_units'),
      ledger: await w.count('ledger_entries'),
    });
    const before = await counts();
    await alertFor('partial_composite');
    await run();
    const report = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer1,
    });
    expect(report.ok).toBe(true);
    for (const c of await casesOf()) {
      const r = await resolve(w.deps as never, {
        case_id: c.case_id,
        action: 'close_no_fault',
        by: operator,
        reason: 'kept what worked',
      });
      expect(r.ok).toBe(true);
    }
    await run();
    expect(await counts()).toEqual(before);
  });

  it('buyer report on a partial order (the composition openCase path, order id, no kind) opens payment_unresolved beside the partial case', async () => {
    await pack('declined');
    await alertFor('partial_composite');
    await run();
    // composition.server.ts: kind is payment_unresolved when the buyer names an order, not an item
    const r = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer1,
      note: 'I want a refund',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('payment_unresolved');
    expect(r.value.opened_by).toBe('buyer');
    expect(r.value.buyer_message).toBe(
      'We got your report and are looking into it. You do not need to do anything else.',
    );
    const kinds = (await casesOf()).map((c) => c.kind).sort();
    expect(kinds).toEqual(['partial_composite', 'payment_unresolved']);
    // 4 h SLA for the report, 24 h for the partial case
    const sla = await w.db.query<{ kind: string; ms: number }>(
      `SELECT kind, (extract(epoch FROM (sla_due_at - created_at)) * 1000)::bigint AS ms FROM recovery_cases ORDER BY kind`,
    );
    expect(sla.rows.map((x) => [x.kind, Number(x.ms)])).toEqual([
      ['partial_composite', 24 * 3_600_000],
      ['payment_unresolved', 4 * 3_600_000],
    ]);
    // a buyer cannot open the partial kind or a refund through this path of kinds they do not own
    const nope = await openCase(w.deps, {
      kind: 'partial_composite',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer1,
    });
    expect(nope).toEqual({ ok: false, error: { code: 'not_operator' } });
  });

  it('another buyer sees no case of this order and cannot open one on it', async () => {
    await pack('declined');
    await alertFor('partial_composite');
    await run();
    expect(await listCasesForBuyer(w.db, { buyer_id: 'buy_2' })).toEqual([]);
    const r = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer2,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await w.count('recovery_cases')).toBe(1);
  });

  it('a second report on the same order is a duplicate, not a second case', async () => {
    await pack('declined');
    const first = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer1,
    });
    expect(first.ok).toBe(true);
    const second = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer1,
    });
    expect(second).toEqual({ ok: false, error: { code: 'duplicate_open' } });
  });

  it('operator refunds the captured unit (CO-8 rows), then close_no_fault: both cases closed, no refund_in_flight left on the unit, nothing reopens', async () => {
    await pack('declined');
    await alertFor('partial_composite');
    await run();
    const report = await openCase(w.deps, {
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      opened_by: 'buyer',
      actor: buyer1,
    });
    if (!report.ok) throw new Error('report refused');
    // What POST /api/refunds (requestRefund + executeRefund) leaves behind for the captured unit:
    // a completed request, the unit refunded. The offer_refund path would leave a `requested` row.
    await w.insert('refund_requests', {
      id: 'rfr_1',
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      amount_minor: 500,
      currency: 'USD',
      reason: 'buyer asked on the help page',
      requested_by: 'operator:opr_1',
      state: 'completed',
      refund_id: 'RFD1',
    });
    await w.db.query(
      "UPDATE order_units SET status = 'refunded', refunded_minor = 500 WHERE id = 'unt_1'",
    );
    const closed = await resolve(w.deps as never, {
      case_id: report.value.case_id,
      action: 'close_no_fault',
      by: operator,
      reason: 'refunded 5.00 for the Harbour title at the buyer request',
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.state).toBe('closed_no_fault');
    expect(closed.value.buyer_message).toBe(
      'We checked and found no fault. refunded 5.00 for the Harbour title at the buyer request',
    );
    const partial = (await casesOf('partial_composite'))[0]!;
    const closedPartial = await resolve(w.deps as never, {
      case_id: partial.case_id,
      action: 'close_no_fault',
      by: operator,
      reason: 'refund made on the other case',
    });
    expect(closedPartial.ok && closedPartial.value.state).toBe('closed_no_fault');
    const open = await w.db.query(
      "SELECT 1 FROM refund_requests WHERE unit_id = 'unt_1' AND state IN ('requested', 'sent', 'unknown', 'pending')",
    );
    expect(open.rows).toEqual([]);
    expect((await casesOf()).map((c) => c.state)).toEqual(['closed_no_fault', 'closed_no_fault']);
    // closed cases stay closed: the same alert opens nothing again
    expect(await run()).toEqual({ opened: 0, restored: 0 });
    expect((await casesOf()).every((c) => c.state === 'closed_no_fault')).toBe(true);
  });

  it('the partial case can be closed (it never stays open for good) but never as "not charged": a unit holds a verified capture', async () => {
    await pack('declined');
    await alertFor('partial_composite');
    await run();
    const partial = (await casesOf('partial_composite'))[0]!;
    const wrong = await resolve(w.deps as never, {
      case_id: partial.case_id,
      action: 'close_not_charged',
      by: operator,
      reason: 'x',
    });
    expect(wrong).toEqual({ ok: false, error: { code: 'wrong_state' } });
    const kept = await resolve(w.deps as never, {
      case_id: partial.case_id,
      action: 'close_no_fault',
      by: operator,
      reason: 'buyer keeps what worked',
    });
    expect(kept.ok && kept.value.state).toBe('closed_no_fault');
  });

  it('a buyer cannot resolve a case, with or without a refund path wired', async () => {
    await pack('declined');
    await alertFor('partial_composite');
    await run();
    const partial = (await casesOf('partial_composite'))[0]!;
    for (const action of ['close_no_fault', 'offer_refund', 'close_not_charged'] as const) {
      const r = await resolve(w.deps as never, {
        case_id: partial.case_id,
        action,
        by: buyer1,
        reason: 'x',
      });
      expect(r).toEqual({ ok: false, error: { code: 'not_operator' } });
    }
    expect((await casesOf('partial_composite'))[0]?.state).toBe('open');
  });
});
