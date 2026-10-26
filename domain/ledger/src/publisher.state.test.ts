// DP-4 (MVP-D, D-06, P11 per publisher): the ledger of a two-publisher order, summed by publisher.
// PGlite. Harbour (pub_1) and Quayside (pub_2) are fictional publishers of one order of two
// PayPal orders. Money is booked only for a unit with a verified capture, so a declined or
// not-yet-captured PayPal order has no ledger row and its publisher has net 0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerEntryInput, Result } from '@umsbx/contracts';
import { appendLedgerEntry, listLedger, publisherBalances } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
let n = 0;
beforeAll(async () => {
  w = await makeWorld('pub');
  await w.insert('publishers', {
    id: 'pub_2',
    slug: 'p2',
    display_name: 'Quayside',
    country: 'US',
    paypal_merchant_id: 'MERCH2',
    payee_verified_at: w.clock.now().toISOString(),
  });
});
afterAll(async () => {
  await w.close();
});

const append = (e: LedgerEntryInput) => w.db.transaction((tx) => appendLedgerEntry(tx, w.deps, e));
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

/** One order of two units: Harbour 400 and Quayside 250. `captured` says which are verified and booked. */
async function pack(captured: { harbour: boolean; quayside: boolean }) {
  n += 1;
  const base = await w.order(n, { amount_minor: 400 });
  // w.order made the Harbour unit unt_n as captured; shape it to this test.
  const harbour = { unit_id: base.unit_id, capture_id: base.capture_id };
  if (!captured.harbour) {
    await w.db.query(
      `UPDATE order_units SET status = 'declined', capture_id = NULL, captured_verified_at = NULL WHERE id = $1`,
      [harbour.unit_id],
    );
  }
  const quayside = { unit_id: `unt_${n}_q`, capture_id: `CAP${n}Q` };
  await w.insert('order_units', {
    id: quayside.unit_id,
    order_id: base.order_id,
    provider_order_ref: null,
    publisher_id: 'pub_2',
    reference_id: `refid_${n}_q`,
    payee_merchant_id: 'MERCH2',
    amount_minor: 250,
    platform_fee_minor: 0,
    capture_id: captured.quayside ? quayside.capture_id : null,
    status: captured.quayside ? 'captured_verified' : 'declined',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 0,
    captured_verified_at: captured.quayside ? w.clock.now().toISOString() : null,
    mismatch_reason: null,
  });
  if (captured.harbour) {
    value(
      await append({
        unit_id: harbour.unit_id,
        capture_id: harbour.capture_id,
        kind: 'sale',
        amount: { currency: 'USD', minor: 400 },
        refund_id: null,
        ref_entry_id: null,
      }),
    );
  }
  if (captured.quayside) {
    value(
      await append({
        unit_id: quayside.unit_id,
        capture_id: quayside.capture_id,
        kind: 'sale',
        amount: { currency: 'USD', minor: 250 },
        refund_id: null,
        ref_entry_id: null,
      }),
    );
  }
  return { order_id: base.order_id, harbour, quayside };
}

/** The ledger rows of an order, each with the publisher of its unit. */
async function balancesOf(order_id: string) {
  const owner = new Map(
    (
      await w.db.query<{ id: string; publisher_id: string }>(
        'SELECT id, publisher_id FROM order_units WHERE order_id = $1',
        [order_id],
      )
    ).rows.map((r) => [r.id, r.publisher_id]),
  );
  const rows = (await listLedger(w.db, { order_id })).map((entry) => ({
    publisher_id: owner.get(entry.unit_id)!,
    entry,
  }));
  return publisherBalances(rows);
}
const of = (b: Awaited<ReturnType<typeof balancesOf>>, publisher_id: string) =>
  b.find((x) => x.publisher_id === publisher_id);

describe('D-06: ledger sums per publisher', () => {
  it('D-06 PO1 captured, PO2 declined: Harbour net = its amount, Quayside 0', async () => {
    const p = await pack({ harbour: true, quayside: false });
    const b = await balancesOf(p.order_id);
    expect(of(b, 'pub_1')).toMatchObject({ sold_minor: 400, refunded_minor: 0, net_minor: 400 });
    // no row at all for Quayside: no sale was booked, so its net is 0
    expect(of(b, 'pub_2')?.net_minor ?? 0).toBe(0);
    expect(b.reduce((sum, x) => sum + x.net_minor, 0)).toBe(400);
  });

  it('both captured: each publisher has its own amount, and the nets add to the order total', async () => {
    const p = await pack({ harbour: true, quayside: true });
    const b = await balancesOf(p.order_id);
    expect(of(b, 'pub_1')?.net_minor).toBe(400);
    expect(of(b, 'pub_2')?.net_minor).toBe(250);
    expect(b.reduce((sum, x) => sum + x.net_minor, 0)).toBe(650);
  });

  it('partial refund on Harbour reduces only Harbour', async () => {
    const p = await pack({ harbour: true, quayside: true });
    value(
      await append({
        unit_id: p.harbour.unit_id,
        capture_id: p.harbour.capture_id,
        kind: 'refund',
        amount: { currency: 'USD', minor: 150 },
        refund_id: 'RFH1',
        ref_entry_id: null,
      }),
    );
    const b = await balancesOf(p.order_id);
    expect(of(b, 'pub_1')).toMatchObject({ sold_minor: 400, refunded_minor: 150, net_minor: 250 });
    expect(of(b, 'pub_2')).toMatchObject({ sold_minor: 250, refunded_minor: 0, net_minor: 250 });
  });

  it('a full refund of Quayside leaves Harbour whole; a paypal_fee row moves neither net', async () => {
    const p = await pack({ harbour: true, quayside: true });
    value(
      await append({
        unit_id: p.quayside.unit_id,
        capture_id: p.quayside.capture_id,
        kind: 'refund',
        amount: { currency: 'USD', minor: 250 },
        refund_id: 'RFQ1',
        ref_entry_id: null,
      }),
    );
    value(
      await append({
        unit_id: p.harbour.unit_id,
        capture_id: p.harbour.capture_id,
        kind: 'paypal_fee',
        amount: { currency: 'USD', minor: 42 },
        refund_id: null,
        ref_entry_id: null,
      }),
    );
    const b = await balancesOf(p.order_id);
    expect(of(b, 'pub_1')?.net_minor).toBe(400);
    expect(of(b, 'pub_2')).toMatchObject({ refunded_minor: 250, net_minor: 0 });
  });

  it('the ledger stays append-only: no update and no delete reach a row of either publisher', async () => {
    const p = await pack({ harbour: true, quayside: true });
    await expect(
      w.db.query('UPDATE ledger_entries SET amount_minor = 1 WHERE unit_id = $1', [
        p.quayside.unit_id,
      ]),
    ).rejects.toThrow();
    await expect(
      w.db.query('DELETE FROM ledger_entries WHERE unit_id = $1', [p.harbour.unit_id]),
    ).rejects.toThrow();
  });
});
