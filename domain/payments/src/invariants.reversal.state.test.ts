// DP-2c item 4 (MVP-D): INV7 counts `reversal` rows in the ledger net (sale minus refunds minus
// reversals) but compares that net with the units' `amount_minor - refunded_minor`. RULE FOR A FUTURE
// REVERSAL BOOKING: it must move BOTH the ledger (a `reversal` row) and the unit's `refunded_minor` in
// the same transaction, or INV7 fails for the publisher. This file pins the current behaviour; the check
// itself is unchanged (docs/READINESS.md, DP-2c). Drift is injected with test-only SQL. Real PGlite.
import { afterEach, describe, expect, it } from 'vitest';
import { checkInvariants } from './index';
import { makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const inv7 = async () => (await checkInvariants(w.db)).find((r) => r.id === 'INV7')!;
const unitOf = async (order_id: string, publisher_id: string) =>
  (
    await w.rows<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1 AND publisher_id = $2',
      [order_id, publisher_id],
    )
  )[0]!;
/** A reversal row written by hand (a reversal row carries no refund id). */
const injectReversal = (unit_id: string, capture_id: string, minor: number) =>
  w.rows(
    `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id,
        ref_entry_id, environment, created_at, updated_at)
     SELECT $1, u.id, $3, 'reversal', $4, o.currency, NULL, NULL, o.environment, now(), now()
       FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $2`,
    [`led_inject_reversal_${unit_id}`, unit_id, capture_id, minor],
  );

describe('INV7 and reversal rows (DP-2c, pinned)', () => {
  it('a reversal row alone moves the ledger net but not refunded_minor: INV7 fails for that publisher only', async () => {
    w = await makeWorld();
    const a = await paid(w, PACK);
    expect((await inv7()).ok).toBe(true);
    const quayside = await unitOf(a.order_id, 'pub_2');
    await injectReversal(quayside.id, quayside.capture_id, 40);
    const found = await inv7();
    expect(found.ok).toBe(false);
    expect(found.detail).toContain('pub_2');
    expect(found.detail).not.toContain('pub_1');
    // the ledger is 40 lower than the units say: the reversal row counts in the net
    expect(found.detail).toContain('difference -40');
  });

  it('a reversal row together with the same amount in refunded_minor holds: the booking must move both', async () => {
    w = await makeWorld();
    const a = await paid(w, PACK);
    const quayside = await unitOf(a.order_id, 'pub_2');
    await injectReversal(quayside.id, quayside.capture_id, 40);
    await w.rows('UPDATE order_units SET refunded_minor = 40 WHERE id = $1', [quayside.id]);
    expect((await inv7()).ok).toBe(true);
  });
});
