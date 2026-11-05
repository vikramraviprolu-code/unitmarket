// POB-M1 (D-089): the payout. A sale is paid out to the publisher only after its access window has ended, with no open
// refund and no full refund; one payout per publisher and currency; a refund inside the window shrinks or removes it;
// a refund after the payout is netted against the next one. Dry run only: the port here is a scripted double.
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelRefundRequest,
  executeRefund,
  requestRefund,
  runPayoutPass,
  suspectReversal,
} from './index';
import { OPERATOR, awaiting, makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import {
  FIVE_DAYS_MS,
  atEnd,
  itemsOf,
  ledgerKinds,
  pastWindow,
  payoutRows,
  priced,
  recording,
  spyPort,
  unitIdOf,
} from './payout-support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const usd = (minor: number) => ({ currency: 'USD', minor });
const pass = (
  port: ReturnType<typeof spyPort> | null,
  deps = w.deps,
  o: { max_items?: number; max_minor?: number } = {},
) => runPayoutPass(deps, port, { max_items: 100, ...o });

async function refund(unit_id: string, minor: number | null) {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  const e = await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
  if (!e.ok) throw new Error('refund not executed');
  return r.value.refund_request_id;
}
const alertsOf = (kind: string) =>
  w.rows<{ detail: { reason: string }; unit_id: string | null }>(
    'SELECT detail, unit_id FROM alerts WHERE kind = $1 ORDER BY created_at, id',
    [kind],
  );

describe('the split at capture', () => {
  it('a fee 40 on a 400 offer: the sale stays 400, the fee row is 40, the payable row is 360, parts are copied', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    const kinds = await ledgerKinds(w, unit);
    expect(kinds.filter((k) => ['sale', 'fee', 'payable'].includes(k.kind))).toEqual(
      expect.arrayContaining([
        { kind: 'sale', amount_minor: 400, refund_id: null },
        { kind: 'fee', amount_minor: 40, refund_id: null },
        { kind: 'payable', amount_minor: 360, refund_id: null },
      ]),
    );
    expect(
      await w.rows(
        'SELECT seller_minor::int AS s, fee_minor::int AS f, tax_minor::int AS t FROM order_unit_parts',
      ),
    ).toEqual([{ s: 360, f: 40, t: 0 }]);
    expect(
      (
        await w.rows<{ amount_minor: number; platform_fee_minor: number }>(
          'SELECT amount_minor, platform_fee_minor FROM order_units',
        )
      )[0],
    ).toEqual({ amount_minor: 400, platform_fee_minor: 0 });
  });

  it('an offer with no fee parts still gets parts and a payable row equal to the sale', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    const kinds = await ledgerKinds(w, unit);
    expect(kinds.find((k) => k.kind === 'fee')).toBeUndefined();
    expect(kinds.find((k) => k.kind === 'payable')).toEqual({
      kind: 'payable',
      amount_minor: 400,
      refund_id: null,
    });
    expect(
      await w.rows('SELECT seller_minor::int AS s, fee_minor::int AS f FROM order_unit_parts'),
    ).toEqual([{ s: 400, f: 0 }]);
  });

  it('a pack of two publishers copies the parts of each unit', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await priced(w, 'ofr_3', 350, 50);
    const a = await paid(w, { offers: ['ofr_1', 'ofr_3'] });
    const parts = await w.rows<{ publisher_id: string; s: number; f: number }>(
      `SELECT u.publisher_id, p.seller_minor::int AS s, p.fee_minor::int AS f
         FROM order_unit_parts p JOIN order_units u ON u.id = p.unit_id WHERE u.order_id = $1 ORDER BY u.publisher_id`,
      [a.order_id],
    );
    expect(parts).toEqual([
      { publisher_id: 'pub_1', s: 360, f: 40 },
      { publisher_id: 'pub_2', s: 350, f: 50 },
    ]);
  });

  it('a unit gets the sum of the parts of its items (two offers of one publisher)', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await priced(w, 'ofr_2', 350, 50);
    await paid(w, { offers: ['ofr_1', 'ofr_2'] });
    expect(
      await w.rows('SELECT seller_minor::int AS s, fee_minor::int AS f FROM order_unit_parts'),
    ).toEqual([{ s: 710, f: 90 }]);
    expect((await ledgerKinds(w)).filter((k) => ['fee', 'payable'].includes(k.kind))).toEqual(
      expect.arrayContaining([
        { kind: 'fee', amount_minor: 90, refund_id: null },
        { kind: 'payable', amount_minor: 710, refund_id: null },
      ]),
    );
  });

  it('a later insert for another offer version or a fee change cannot alter a sale already made', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await paid(w);
    await expect(
      w.rows('UPDATE order_unit_parts SET fee_minor = 0, seller_minor = 400'),
    ).rejects.toThrow();
    await expect(
      w.rows('UPDATE offer_price_parts SET fee_minor = 0, seller_minor = 400'),
    ).rejects.toThrow();
  });
});

describe('when a payout is due', () => {
  it('not inside the window: nothing is created before the window has ended', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await paid(w);
    const port = spyPort(w);
    w.tick(24 * 3_600_000);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 0 });
    w.tick(FIVE_DAYS_MS - 24 * 3_600_000 - 1000);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 0 });
    expect(await payoutRows(w)).toEqual([]);
    expect(port.calls).toHaveLength(0);
  });

  it('after the window it is due: one payout of the publisher share, sent once to the stored payee', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await paid(w);
    const port = spyPort(w);
    pastWindow(w);
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1, netted: 0 });
    const rows = await payoutRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publisher_id: 'pub_1',
      currency: 'USD',
      amount_minor: 360,
      state: 'sent',
      environment: 'dryrun',
      payee_merchant_id: 'MERCH1',
      provider_ref: `SPY-umsP-${rows[0]!.id}`,
    });
    expect(rows[0]!.idempotency_key).toBe(`umsP-${rows[0]!.id}`);
    expect(rows[0]!.id).toMatch(/^pay_/);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({
      payout_id: rows[0]!.id,
      idempotency_key: `umsP-${rows[0]!.id}`,
      publisher_id: 'pub_1',
      payee_merchant_id: 'MERCH1',
      amount: { currency: 'USD', minor: 360 },
      environment: 'dryrun',
    });
    expect(port.inTx).toEqual([false]);
    expect(await itemsOf(w, rows[0]!.id)).toEqual([
      {
        order_unit_id: await unitIdOf(
          w,
          (await w.rows<{ id: string }>('SELECT id FROM orders'))[0]!.id,
        ),
        seller_minor: 360,
        live: true,
      },
    ]);
  });

  it('a confirming provider puts the payout straight to confirmed', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    await pass(spyPort(w, 'confirm'));
    expect((await payoutRows(w))[0]!.state).toBe('confirmed');
  });

  it('the exact end of the window is due, one millisecond before it is not', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    const port = spyPort(w);
    await atEnd(w, unit, -1);
    expect(await pass(port)).toMatchObject({ created: 0 });
    w.tick(1);
    expect(await pass(port)).toMatchObject({ created: 1 });
  });

  it('one payout per publisher: a pack of two publishers makes two payouts', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await priced(w, 'ofr_3', 350, 50);
    await paid(w, { offers: ['ofr_1', 'ofr_3'] });
    pastWindow(w);
    const port = spyPort(w);
    expect(await pass(port)).toMatchObject({ created: 2, sent: 2 });
    expect((await payoutRows(w)).map((p) => [p.publisher_id, p.amount_minor])).toEqual([
      ['pub_1', 360],
      ['pub_2', 350],
    ]);
  });

  it('several sales of one publisher and currency make one payout with one item each', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await priced(w, 'ofr_2', 350, 50);
    await paid(w, { offers: ['ofr_1'] });
    await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    pastWindow(w);
    expect(await pass(spyPort(w))).toMatchObject({ created: 1, sent: 1 });
    const rows = await payoutRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_minor).toBe(710);
    expect(await itemsOf(w, rows[0]!.id)).toHaveLength(2);
  });

  it('a sale whose window ends later is paid in a later payout', async () => {
    w = await makeWorld();
    const a = await paid(w, { offers: ['ofr_1'] });
    w.tick(30 * 60_000);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    const port = spyPort(w);
    await atEnd(w, await unitIdOf(w, a.order_id), 1000); // the first window is over, the second is not
    expect(await pass(port)).toMatchObject({ created: 1 });
    await atEnd(w, await unitIdOf(w, b.order_id), 1000);
    expect(await pass(port)).toMatchObject({ created: 1 });
    expect((await payoutRows(w)).map((p) => p.amount_minor)).toEqual([400, 400]);
  });

  it('running the pass again changes nothing: one payout, one send, one key', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await paid(w);
    pastWindow(w);
    const port = spyPort(w);
    await pass(port);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 0, netted: 0 });
    w.tick(10 * 3_600_000);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 0 });
    expect(await payoutRows(w)).toHaveLength(1);
    expect(port.calls).toHaveLength(1);
    expect(new Set(port.calls.map((c) => c.idempotency_key)).size).toBe(1);
  });

  it('two passes at once still make one payout', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w);
    await Promise.all([pass(port), pass(port)]);
    expect(await payoutRows(w)).toHaveLength(1);
    expect(new Set(port.calls.map((c) => c.idempotency_key)).size).toBe(1);
    expect(port.executed).toHaveLength(1);
  });

  it('a payout is cut at the ceiling: sales that do not fit together go in separate payouts', async () => {
    w = await makeWorld();
    for (const [i, offer] of (['ofr_1', 'ofr_2'] as const).entries()) {
      await paid(w, { buyer_id: i === 0 ? 'buy_A' : 'buy_B', offers: [offer] });
    }
    await paid(w, { buyer_id: 'buy_A', offers: ['ofr_3'] });
    pastWindow(w);
    // ofr_1 and ofr_2 are pub_1 (400 each): with a ceiling of 600 they cannot share one payout.
    expect(await pass(spyPort(w), w.deps, { max_minor: 600 })).toMatchObject({ created: 3 });
    expect((await payoutRows(w)).map((p) => [p.publisher_id, p.amount_minor])).toEqual([
      ['pub_1', 400],
      ['pub_1', 400],
      ['pub_2', 400],
    ]);
  });

  it('with a ceiling that fits both, they share one payout', async () => {
    w = await makeWorld();
    await paid(w, { offers: ['ofr_1'] });
    await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    pastWindow(w);
    expect(await pass(spyPort(w), w.deps, { max_minor: 800 })).toMatchObject({ created: 1 });
    expect((await payoutRows(w))[0]!.amount_minor).toBe(800);
  });

  it('without a port the payouts are created due and nothing is sent', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    expect(await pass(null)).toMatchObject({ created: 1, sent: 0 });
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['due']);
    const port = spyPort(w);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 1 });
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['sent']);
  });

  it('audits the creation and the sending', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const rec = recording(w);
    await pass(spyPort(w), rec.deps);
    expect(rec.audits.map((a) => a.action)).toEqual(['payout.created', 'payout.sent']);
    expect(rec.audits.every((a) => a.actor.kind === 'system')).toBe(true);
    expect(rec.audits[0]!.detail).toMatchObject({
      amount_minor: 400,
      currency: 'USD',
      publisher_id: 'pub_1',
    });
    expect(JSON.stringify(rec.audits)).not.toMatch(/MERCH1/); // the payee is not copied into the audit trail
  });
});

describe('what keeps a sale from being paid', () => {
  it('a sale that was never captured and verified', async () => {
    w = await makeWorld();
    await awaiting(w);
    pastWindow(w);
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
  });

  it('an open refund request holds the payout until the request is settled', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    const r = await requestRefund(w.deps, {
      unit_id: unit,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    const port = spyPort(w);
    expect(await pass(port)).toMatchObject({ created: 0 });
    await cancelRefundRequest(w.deps, r.value.refund_request_id, OPERATOR);
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1 });
  });

  it('a unit refunded in full is never paid', async () => {
    w = await makeWorld();
    const a = await paid(w);
    await refund(await unitIdOf(w, a.order_id), null);
    pastWindow(w);
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
    expect(await payoutRows(w)).toEqual([]);
  });

  it('a unit under a suspected reversal is not paid', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const cap = (await w.captureIds(a.order_id))[0]!;
    await suspectReversal(w.deps, { capture_id: cap, source: 'manual' });
    pastWindow(w);
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
  });

  it('a window that never started is not a window that ended', async () => {
    w = await makeWorld();
    await paid(w);
    await w.rows(
      "UPDATE access_windows SET state = 'not_started', started_at = NULL, base_ends_at = NULL, ends_at = NULL",
    );
    pastWindow(w);
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
  });

  it('a unit of another environment is left to its own app', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const other = { ...w.deps, environment: 'sandbox' as const };
    expect(await pass(spyPort(w), other)).toMatchObject({ created: 0 });
  });
});

describe('a refund inside the window', () => {
  it('a full refund: no payout, and the ledger holds the three reversals', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    await refund(unit, null);
    const k = await ledgerKinds(w, unit);
    expect(k.filter((x) => x.kind === 'refund').map((x) => x.amount_minor)).toEqual([400]);
    expect(k.filter((x) => x.kind === 'fee_reversal').map((x) => x.amount_minor)).toEqual([40]);
    expect(k.filter((x) => x.kind === 'payable_reversal').map((x) => x.amount_minor)).toEqual([
      360,
    ]);
    pastWindow(w);
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
  });

  it('a partial refund: the payout is the payable left, 270 of 360 after a 100 refund', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    await refund(await unitIdOf(w, a.order_id), 100);
    pastWindow(w);
    await pass(spyPort(w));
    const rows = await payoutRows(w);
    expect(rows.map((p) => [p.amount_minor, p.state])).toEqual([[270, 'sent']]);
    expect((await itemsOf(w, rows[0]!.id))[0]!.seller_minor).toBe(270);
  });
});

describe('a refund after the payout was created but before it was sent', () => {
  it('cancels the payout, frees its units, and the next pass pays the smaller amount', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    await pass(null); // created, due, not sent
    const first = (await payoutRows(w))[0]!;
    expect(first.state).toBe('due');
    const rec = recording(w);
    const r = await requestRefund(rec.deps, {
      unit_id: unit,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    // an open request does not cancel anything yet; the booking does
    await executeRefund(rec.deps, { refund_request_id: r.value.refund_request_id });
    const rows = await payoutRows(w);
    expect(rows.map((p) => p.state)).toEqual(['cancelled']);
    expect(await itemsOf(w, first.id)).toEqual([expect.objectContaining({ live: false })]);
    expect(rec.audits.map((x) => x.action)).toContain('payout.cancelled');
    const port = spyPort(w);
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1 });
    expect((await payoutRows(w)).map((p) => [p.state, p.amount_minor])).toEqual([
      ['cancelled', 360],
      ['sent', 270],
    ]);
    expect(port.calls).toHaveLength(1);
  });

  it('a full refund then leaves no payout at all', async () => {
    w = await makeWorld();
    const a = await paid(w);
    pastWindow(w);
    await pass(null);
    await refund(await unitIdOf(w, a.order_id), null);
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['cancelled']);
    expect(await pass(spyPort(w))).toMatchObject({ created: 0, sent: 0 });
  });
});

describe('a refund after the payout was sent', () => {
  it('books a payout adjustment for the publisher share of the refund and raises an alert; the payout stays', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    await pass(spyPort(w));
    const id = await refund(unit, 100);
    const k = await ledgerKinds(w, unit);
    expect(k.filter((x) => x.kind === 'payout_adjustment')).toHaveLength(1);
    const adj = (
      await w.rows<{ amount_minor: number; refund_id: string; currency: string }>(
        "SELECT amount_minor::int AS amount_minor, refund_id, currency FROM ledger_entries WHERE kind = 'payout_adjustment'",
      )
    )[0]!;
    expect(adj).toMatchObject({ amount_minor: 90, currency: 'USD' });
    expect(adj.refund_id).toBeTruthy();
    expect(id).toBeTruthy();
    expect((await payoutRows(w)).map((p) => [p.state, p.amount_minor])).toEqual([['sent', 360]]);
    const alerts = await alertsOf('payout_adjustment');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.unit_id).toBe(unit);
    expect(alerts[0]!.detail.reason).toBe(`adjust_${adj.refund_id}`);
  });

  it('a second refund of the same unit books a second adjustment, and a replay books none', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    await pass(spyPort(w));
    const first = await refund(unit, 100);
    await refund(unit, 50);
    await executeRefund(w.deps, { refund_request_id: first }); // replay
    expect(
      (
        await w.rows(
          "SELECT amount_minor::int AS a FROM ledger_entries WHERE kind = 'payout_adjustment' ORDER BY amount_minor",
        )
      ).map((r) => (r as { a: number }).a),
    ).toEqual([50, 100]);
  });

  it('a refund that is only the fee reverses no payable and books no adjustment', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 99, 301, 3000); // an unusual split: the fee is most of the price
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    await pass(spyPort(w));
    await refund(unit, 1); // 1 * 301 / 400 = 0.75 -> fee part 1, payable 0
    expect(
      (await ledgerKinds(w, unit)).find((x) => x.kind === 'payout_adjustment'),
    ).toBeUndefined();
    expect(await alertsOf('payout_adjustment')).toEqual([]);
  });

  it('A paid then refunded, B earned: the next payout is netted, never negative, and is not sent', async () => {
    w = await makeWorld();
    const a = await paid(w, { offers: ['ofr_1'] }); // A: 400 payable
    const unitA = await unitIdOf(w, a.order_id);
    w.tick(30 * 60_000);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] }); // B: 400 payable, its window ends later
    const port = spyPort(w);
    await atEnd(w, unitA, 1000);
    await pass(port); // A is due and paid
    expect((await payoutRows(w)).map((p) => [p.state, p.amount_minor])).toEqual([['sent', 400]]);
    await refund(unitA, null); // refunded after the payout: an adjustment of 400
    await atEnd(w, await unitIdOf(w, b.order_id), 1000);
    const sendsBefore = port.calls.length;
    expect(await pass(port)).toMatchObject({ created: 1, netted: 1, sent: 0 });
    const rows = await payoutRows(w);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      amount_minor: 0,
      state: 'confirmed',
      provider_ref: `NETTED-${rows[1]!.id}`,
    });
    expect(port.calls.length).toBe(sendsBefore); // a payout of 0 is never sent
    // the adjustment is used up: running again changes nothing
    expect(await pass(port)).toMatchObject({ created: 0, netted: 0 });
    const live = await w.rows<{ n: number }>(
      'SELECT coalesce(sum(amount_minor), 0)::int AS n FROM adjustment_settlements WHERE live',
    );
    expect(live[0]!.n).toBe(400);
  });

  it('an adjustment larger than the next payout is used in part and the rest waits for the next sale', async () => {
    w = await makeWorld();
    const a = await paid(w, { offers: ['ofr_1'] });
    const unitA = await unitIdOf(w, a.order_id);
    w.tick(30 * 60_000);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    const unitB = await unitIdOf(w, b.order_id);
    await refund(unitB, 300); // B inside its window: 100 of payable left
    w.tick(60 * 60_000);
    const c = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_1'] }); // C: 400, ends last
    const port = spyPort(w);
    await atEnd(w, unitA, 1000);
    await pass(port);
    await refund(unitA, null); // adjustment 400
    await atEnd(w, unitB, 1000);
    expect(await pass(port)).toMatchObject({ created: 1, netted: 1 });
    const settled = await w.rows<{ n: number }>(
      'SELECT sum(amount_minor)::int AS n FROM adjustment_settlements WHERE live',
    );
    expect(settled[0]!.n).toBe(100); // only B's 100 was there to use
    await atEnd(w, await unitIdOf(w, c.order_id), 1000);
    expect(await pass(port)).toMatchObject({ created: 1, netted: 0, sent: 1 });
    expect((await payoutRows(w)).at(-1)).toMatchObject({ amount_minor: 100, state: 'sent' }); // 400 - 300 left
  });

  it('the payout amount always equals its items minus its live settlements', async () => {
    w = await makeWorld();
    const a = await paid(w, { offers: ['ofr_1'] });
    const unitA = await unitIdOf(w, a.order_id);
    w.tick(30 * 60_000);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    const port = spyPort(w);
    await atEnd(w, unitA, 1000);
    await pass(port);
    await refund(unitA, 150);
    await atEnd(w, await unitIdOf(w, b.order_id), 1000);
    await pass(port);
    const check = await w.rows<{ id: string; amount: number; items: number; settled: number }>(
      `SELECT p.id, p.amount_minor::int AS amount,
              coalesce((SELECT sum(seller_minor) FROM payout_items i WHERE i.payout_id = p.id), 0)::int AS items,
              coalesce((SELECT sum(amount_minor) FROM adjustment_settlements s WHERE s.payout_id = p.id AND s.live), 0)::int AS settled
         FROM payouts p ORDER BY p.created_at, p.id`,
    );
    expect(check).toHaveLength(2);
    for (const c of check) expect(c.amount).toBe(c.items - c.settled);
    expect(check[1]).toMatchObject({ items: 400, settled: 150, amount: 250 });
  });

  it('cancelling a due payout gives back the adjustments it had used', async () => {
    w = await makeWorld();
    const a = await paid(w, { offers: ['ofr_1'] });
    const unitA = await unitIdOf(w, a.order_id);
    w.tick(30 * 60_000);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    const unitB = await unitIdOf(w, b.order_id);
    const port = spyPort(w);
    await atEnd(w, unitA, 1000);
    await pass(port);
    await refund(unitA, 100);
    await atEnd(w, unitB, 1000);
    await pass(null); // B's payout is created due: 400 minus the 100 adjustment
    expect((await payoutRows(w)).at(-1)).toMatchObject({ amount_minor: 300, state: 'due' });
    await refund(unitB, 200); // refunded before it was sent: that payout is cancelled
    const settlements = await w.rows<{ live: boolean }>('SELECT live FROM adjustment_settlements');
    expect(settlements.every((x) => !x.live)).toBe(true);
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1 });
    // B has 200 left; A's 100 adjustment is used again. B's own refund booked no adjustment: B was not paid.
    expect((await payoutRows(w)).at(-1)).toMatchObject({ amount_minor: 100, state: 'sent' });
    expect(
      await w.rows(
        "SELECT 1 FROM ledger_entries WHERE kind = 'payout_adjustment' AND unit_id = $1",
        [unitB],
      ),
    ).toEqual([]);
  });
});
