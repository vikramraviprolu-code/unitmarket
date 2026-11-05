// POB-M1: INV8, per unit the sale equals the fee plus the payable, and the refunds equal the fee and payable reversals.
// It holds after every scenario here and fails on injected drift. Units that were sold before the fee existed (no parts
// row, no fee or payable row) are not judged. Read-only SQL; PGlite.
import { afterEach, describe, expect, it } from 'vitest';
import { checkInvariants, executeRefund, requestRefund } from './index';
import { OPERATOR, makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import { priced, unitIdOf } from './payout-support';

let w: OpsWorld;
afterEach(async () => {
  await w.close();
});
const inv8 = async () => (await checkInvariants(w.db)).find((r) => r.id === 'INV8')!;
async function refund(unit_id: string, minor: number | null) {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : { currency: 'USD', minor },
    reason: 'x',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error('refused');
  await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
}
const raw = (
  unit_id: string,
  capture_id: string,
  id: string,
  kind: string,
  minor: number,
  refund_id: string | null = null,
) =>
  w.insert('ledger_entries', {
    id,
    unit_id,
    capture_id,
    kind,
    amount_minor: minor,
    currency: 'USD',
    refund_id,
    ref_entry_id: null,
    environment: 'dryrun',
  });
const capOf = async (unit_id: string) =>
  (
    await w.rows<{ capture_id: string }>('SELECT capture_id FROM order_units WHERE id = $1', [
      unit_id,
    ])
  )[0]!.capture_id;

describe('INV8', () => {
  it('is the eighth invariant and holds on an empty book', async () => {
    w = await makeWorld();
    const all = await checkInvariants(w.db);
    expect(all.map((x) => x.id)).toEqual([
      'INV1',
      'INV2',
      'INV3',
      'INV4',
      'INV5',
      'INV6',
      'INV7',
      'INV8',
    ]);
    expect(all.every((x) => x.ok)).toBe(true);
    expect((await inv8()).detail).toMatch(/sale equals fee plus payable/);
  });

  it('holds after a sale with a fee, a partial refund and a full refund, and after a sale with no fee', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const ua = await unitIdOf(w, a.order_id);
    expect((await inv8()).ok).toBe(true);
    await refund(ua, 123);
    expect((await inv8()).ok).toBe(true);
    await refund(ua, null);
    expect((await inv8()).ok).toBe(true);
    await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    const all = await checkInvariants(w.db);
    expect(all.filter((x) => !x.ok)).toEqual([]);
  });

  it('fails when the sale is not the fee plus the payable, and names the unit', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitIdOf(w, a.order_id);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_2'] });
    const ub = await unitIdOf(w, b.order_id);
    expect((await inv8()).ok).toBe(true);
    await w.db.exec(
      `ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only;
       UPDATE ledger_entries SET amount_minor = 399 WHERE unit_id = '${ub}' AND kind = 'payable';
       ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only;`,
    );
    const r = await inv8();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(ub);
    expect(r.detail).not.toContain(u);
  });

  it('fails when a captured unit with parts has no payable row', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitIdOf(w, a.order_id);
    await w.db.exec(
      `ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only;
       DELETE FROM ledger_entries WHERE unit_id = '${u}' AND kind = 'payable';
       ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only;`,
    );
    const r = await inv8();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(u);
  });

  it('fails when the refunds are not the fee reversals plus the payable reversals', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const u = await unitIdOf(w, a.order_id);
    await refund(u, 100);
    expect((await inv8()).ok).toBe(true);
    // a refund row with no reversal rows beside it
    await w.rows(
      `UPDATE order_units SET refunded_minor = 150, status = 'partially_refunded' WHERE id = '${u}'`,
    );
    await raw(u, await capOf(u), 'led_drift_refund', 'refund', 50, 'RFDRIFT');
    const r = await inv8();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(u);
  });

  it('does not judge a unit sold before the fee existed (no parts row, no fee or payable row)', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitIdOf(w, a.order_id);
    await w.db.exec(
      `ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only;
       DELETE FROM ledger_entries WHERE unit_id = '${u}' AND kind = 'payable';
       ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only;
       ALTER TABLE order_unit_parts DISABLE TRIGGER USER;
       DELETE FROM order_unit_parts WHERE unit_id = '${u}';
       ALTER TABLE order_unit_parts ENABLE TRIGGER USER;`,
    );
    expect((await inv8()).ok).toBe(true);
  });
});
