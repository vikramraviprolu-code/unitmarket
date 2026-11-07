// M1-LOWS: the low findings of the two reviews of POB-M1 (fee and payouts). Each block names its finding. Real PGlite, a
// scripted payout port, synthetic rows only. Blocks marked "pinned" describe behaviour that is kept on purpose and must not
// change by accident; the others failed before the fix.
import { afterEach, describe, expect, it } from 'vitest';
import type { PayoutPort, PayoutSendResult } from '@umsbx/contracts';
import { executeRefund, requestRefund, runPayoutPass } from './index';
import { OPERATOR, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import {
  atEnd,
  ledgerKinds,
  makePayoutWorld,
  pastWindow,
  payoutRows,
  priced,
  spyPort,
  unitIdOf,
} from './payout-support';
import { place } from './support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const usd = (minor: number) => ({ currency: 'USD', minor });
const pass = (port: PayoutPort | null) => runPayoutPass(w.deps, port, { max_items: 100 });

async function refund(unit_id: string, minor: number | null) {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'goodwill',
    actor: OPERATOR,
    override_reason: 'refund after the payout (test)',
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  const e = await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
  if (!e.ok) throw new Error('refund not executed');
}
const alertReasons = async (kind: string): Promise<string[]> =>
  (
    await w.rows<{ detail: { reason: string } }>(
      'SELECT detail FROM alerts WHERE kind = $1 ORDER BY created_at, id',
      [kind],
    )
  ).map((x) => x.detail.reason);

// The first refund id the scripted PayPal gives out (ops/support.ts makeWorld).
const FIRST_REFUND = 'SBXFAKEREF00001';

describe('M1-L1 pinned: the parts of a refund are refused by a ledger rule while a payout is due', () => {
  it('the refund is booked, an alert is raised, the due payout is cancelled and paid again from the ledger net (overpays, by design of the alert)', async () => {
    w = await makePayoutWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    await pastWindow(w);
    await pass(null); // a due payout of 360
    const first = (await payoutRows(w))[0]!;
    expect([first.state, first.amount_minor]).toEqual(['due', 360]);
    w.tick(1000);
    // A payable_reversal already booked under the refund id the provider is about to give, with another amount: the ledger
    // refuses the parts of the refund as a conflicting replay (after the fee part was written).
    await w.rows(
      `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id,
          ref_entry_id, environment, created_at, updated_at)
       SELECT 'led_conflict_1', u.id, u.capture_id, 'payable_reversal', 1, o.currency, $2, NULL, o.environment, now(), now()
         FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1`,
      [unit, FIRST_REFUND],
    );
    await refund(unit, 100);
    // the refund itself is booked and the unit follows it
    expect((await ledgerKinds(w, unit)).filter((k) => k.kind === 'refund')).toHaveLength(1);
    expect(
      (await w.rows<{ refunded_minor: number }>('SELECT refunded_minor FROM order_units'))[0]!
        .refunded_minor,
    ).toBe(100);
    expect(await alertReasons('refund_unresolved')).toEqual([`ledger_rule_split_${FIRST_REFUND}`]);
    // the payable part (90) still told the payout, which was cancelled and is paid again from the ledger net, where the
    // payable reversal is missing: 360 less the 1 that was injected, not the 270 a clean booking would give
    w.tick(1000);
    await pass(spyPort(w));
    const rows = await payoutRows(w);
    expect(rows.map((p) => p.state)).toEqual(['cancelled', 'sent']);
    const net = (
      await w.rows<{ n: number }>(
        `SELECT (coalesce(sum(amount_minor) FILTER (WHERE kind = 'payable'), 0)
                 - coalesce(sum(amount_minor) FILTER (WHERE kind = 'payable_reversal'), 0))::int AS n FROM ledger_entries`,
      )
    )[0]!.n;
    expect(rows[1]!.amount_minor).toBe(net);
    expect(rows[1]!.amount_minor).toBe(359);
    expect(rows[1]!.amount_minor).toBeGreaterThan(270); // the overpay the alert exists for
  });
});

describe('M1-L2: a split that cannot be computed does not stop the refund from being booked', () => {
  it('books the refund, raises one alert, writes no reversal rows and leaves the payout alone', async () => {
    w = await makePayoutWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    // The database never lets the parts differ from the unit amount; switch its guard off for the length of this setup so
    // the parts (2) are smaller than the refund (100): splitRefund must throw RangeError.
    await w.rows('ALTER TABLE order_unit_parts DISABLE TRIGGER USER');
    await w.rows('UPDATE order_unit_parts SET seller_minor = 1, fee_minor = 1 WHERE unit_id = $1', [
      unit,
    ]);
    await w.rows('ALTER TABLE order_unit_parts ENABLE TRIGGER USER');
    await pastWindow(w);
    await pass(null);
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['due']);
    await refund(unit, 100); // before the fix this threw out of the booking
    const kinds = await ledgerKinds(w, unit);
    expect(kinds.filter((k) => k.kind === 'refund')).toEqual([
      { kind: 'refund', amount_minor: 100, refund_id: FIRST_REFUND },
    ]);
    expect(kinds.filter((k) => ['fee_reversal', 'payable_reversal'].includes(k.kind))).toEqual([]);
    expect(
      (
        await w.rows<{ refunded_minor: number; status: string }>(
          'SELECT refunded_minor, status FROM order_units',
        )
      )[0],
    ).toEqual({ refunded_minor: 100, status: 'partially_refunded' });
    expect(await alertReasons('refund_unresolved')).toEqual([`ledger_rule_split_${FIRST_REFUND}`]);
    // no payable part is known, so the payout is not told (same exposure as M1-L1, and the alert is the guard)
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['due']);
  });
});

describe('M1-L3 pinned: an order whose unit totals 0 cannot be placed', () => {
  it('the parts CHECK (seller_minor >= 1) rolls the whole placement back: no order, no unit', async () => {
    w = await makePayoutWorld({ price: 0 }); // reachable only by writing the offer past the catalogue, which refuses a price below 1
    await expect(place(w)).rejects.toThrow(/order_unit_parts_seller_minor_check/);
    expect(await w.rows('SELECT 1 FROM orders')).toEqual([]);
    expect(await w.rows('SELECT 1 FROM order_units')).toEqual([]);
    expect(await w.rows('SELECT 1 FROM order_unit_parts')).toEqual([]);
  });
});

describe('M1-L4: an answer that cannot be applied does not stop the rest of the pass', () => {
  const answering = (inner: PayoutPort, bad: PayoutSendResult): PayoutPort => ({
    send: (req) => (req.publisher_id === 'pub_1' ? Promise.resolve(bad) : inner.send(req)),
  });
  it.each(['', '   '])(
    'an accepted answer with the provider reference %j leaves that payout sending and the other is still sent',
    async (ref) => {
      w = await makePayoutWorld();
      await paid(w, { offers: ['ofr_1', 'ofr_3'] }); // two publishers, two payouts
      await pastWindow(w);
      const inner = spyPort(w);
      const port = answering(inner, { kind: 'accepted', provider_ref: ref, status: 'sent' });
      const counts = await pass(port); // before the fix the CHECK on provider_ref threw out of the pass
      expect(counts).toMatchObject({ created: 2, sent: 1, errored: 1, failed: 0 });
      const rows = await payoutRows(w);
      expect(rows.map((p) => [p.publisher_id, p.state])).toEqual(
        expect.arrayContaining([
          ['pub_1', 'sending'],
          ['pub_2', 'sent'],
        ]),
      );
      expect(rows.find((p) => p.publisher_id === 'pub_1')!.provider_ref).toBeNull();
      // the provider is fixed: the same payout is sent again with the same key and is applied
      expect(await pass(inner)).toMatchObject({ created: 0, sent: 1, errored: 0 });
      expect((await payoutRows(w)).map((p) => p.state).sort()).toEqual(['sent', 'sent']);
      expect(new Set(inner.calls.map((c) => c.idempotency_key)).size).toBe(2);
    },
  );
});

describe('M1-L8: a payout already handed to the provider that is refused again', () => {
  it('stays sending, is sent again with the same key once the publisher can be paid, and its alert says it is sending', async () => {
    w = await makePayoutWorld();
    await paid(w);
    await pastWindow(w);
    const port = spyPort(w, 'throw_before_execute');
    expect(await pass(port)).toMatchObject({ created: 1, errored: 1 });
    const p = (await payoutRows(w))[0]!;
    expect(p.state).toBe('sending');
    await w.rows("UPDATE publishers SET status = 'suspended' WHERE id = 'pub_1'");
    expect(await pass(port)).toMatchObject({ sent: 0, refused: 1 });
    expect(await pass(port)).toMatchObject({ sent: 0, refused: 1 }); // once per payout and reason
    expect(await alertReasons('payout_failed')).toEqual([
      `payout_refused_${p.id}_inactive_sending`,
    ]);
    expect((await payoutRows(w)).map((x) => x.state)).toEqual(['sending']);
    expect(port.calls).toHaveLength(1);
    // the publisher is active again: the pass finishes the send it had started, with the stored key
    await w.rows("UPDATE publishers SET status = 'active' WHERE id = 'pub_1'");
    expect(await pass(port)).toMatchObject({ sent: 1, refused: 0 });
    expect(port.calls.map((c) => c.idempotency_key)).toEqual([
      p.idempotency_key,
      p.idempotency_key,
    ]);
  });
});

describe('M1-L10 pinned: an adjustment with no source row is netted, never forgotten', () => {
  it('a payout_adjustment whose source row is missing still comes off the next payout', async () => {
    w = await makePayoutWorld();
    const a = await paid(w, { offers: ['ofr_1'] }); // 400
    const unitA = await unitIdOf(w, a.order_id);
    w.tick(30 * 60_000);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] }); // 400, its window ends later
    const port = spyPort(w);
    await atEnd(w, unitA, 1000);
    await pass(port);
    await refund(unitA, 100); // after the payout: an adjustment of 100 and its source row
    expect(await w.rows('SELECT 1 FROM payout_adjustment_sources')).toHaveLength(1);
    // the row onRefundBooked writes in the same transaction is gone (only a hand edit or a foreign restore can do this)
    await w.rows(
      'ALTER TABLE payout_adjustment_sources DISABLE TRIGGER payout_adjustment_sources_append_only',
    );
    await w.rows('DELETE FROM payout_adjustment_sources');
    await w.rows(
      'ALTER TABLE payout_adjustment_sources ENABLE TRIGGER payout_adjustment_sources_append_only',
    );
    await atEnd(w, await unitIdOf(w, b.order_id), 1000);
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1 });
    expect((await payoutRows(w)).at(-1)).toMatchObject({ amount_minor: 300, state: 'sent' });
  });
});
