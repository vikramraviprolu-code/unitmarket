// DP-4 (MVP-D, D-06, P11 per publisher): INV7. For each publisher, the ledger net (sale minus
// refunds minus reversals, fee rows ignored) equals the sum, over that publisher's units, of the
// verified captured amount minus refunded_minor; and a capture id belongs to exactly one unit. A
// failing INV7 names the publisher and the difference in the one report, so drift on two publishers
// is caught in one pass. Drift is injected with test-only direct SQL; the ledger has no update or
// delete path. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { checkInvariants, executeRefund, onBuyerReturn, requestRefund } from './index';
import { BUYER_A, OPERATOR, approved, makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const report = async () => await checkInvariants(w.db);
const failing = async (): Promise<string[]> =>
  (await report()).filter((r) => !r.ok).map((r) => r.id);
const inv7 = async () => (await report()).find((r) => r.id === 'INV7')!;
const unitOf = async (order_id: string, publisher_id: string) =>
  (
    await w.rows<{ id: string; capture_id: string | null }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1 AND publisher_id = $2',
      [order_id, publisher_id],
    )
  )[0]!;
/** A ledger row written by hand (the guard trigger still runs; the module's own checks do not). */
const injectLedger = (
  unit_id: string,
  capture_id: string,
  kind: 'sale' | 'refund',
  minor: number,
  refund_id: string | null,
) =>
  w.rows(
    `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id,
        ref_entry_id, environment, created_at, updated_at)
     SELECT $1, u.id, $3, $4, $5, o.currency, $6, NULL, o.environment, now(), now()
       FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $2`,
    [`led_inject_${unit_id}_${kind}`, unit_id, capture_id, kind, minor, refund_id],
  );
/** The capture id a hand-written sale can use on this unit: its own if PayPal gave one, else a made-up one. */
const captureFor = async (unit: { id: string; capture_id: string | null }, fake: string) => {
  if (unit.capture_id !== null) return unit.capture_id;
  await w.rows('UPDATE order_units SET capture_id = $2 WHERE id = $1', [unit.id, fake]);
  return fake;
};
const partialPack = async () => {
  const a = await approved(w, PACK);
  w.paypal.nextBy.set(a.provider_orders[1]!.provider_order_id as string, {
    status: 'DECLINED',
    fee: null,
  });
  const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
  expect(r.ok && r.value.status).toBe('paid_partial');
  return a;
};

describe('INV7 holds', () => {
  it('is in the report, after INV6, with a detail line', async () => {
    w = await makeWorld();
    const r = await report();
    expect(r.map((x) => x.id)).toEqual(['INV1', 'INV2', 'INV3', 'INV4', 'INV5', 'INV6', 'INV7']);
    const last = r[6]!;
    expect(last.ok).toBe(true);
    expect(last.detail).toMatch(/publisher/i);
  });

  it('INV7 holds after a happy composite and after a partial composite', async () => {
    w = await makeWorld();
    await paid(w, PACK);
    expect(await failing()).toEqual([]);
    expect((await inv7()).ok).toBe(true);
    await w.close();

    w = await makeWorld();
    await partialPack();
    expect(await failing()).toEqual([]);
    expect((await inv7()).detail).toMatch(/holds/);
  });

  it('INV7 holds after a partial refund of one publisher and after a full refund of the other', async () => {
    w = await makeWorld();
    const a = await paid(w, PACK);
    const harbour = await unitOf(a.order_id, 'pub_1');
    const quayside = await unitOf(a.order_id, 'pub_2');
    const refund = async (unit_id: string, minor: number | null) => {
      const r = await requestRefund(w.deps, {
        unit_id,
        amount: minor === null ? null : { currency: 'USD', minor },
        reason: 'x',
        actor: OPERATOR,
      });
      if (!r.ok) throw new Error(`refused: ${r.error.code}`);
      await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    };
    await refund(harbour.id, 100);
    expect(await failing()).toEqual([]);
    await refund(quayside.id, null);
    expect(await failing()).toEqual([]);
  });

  it('INV7 holds for a single-publisher order, paid and refunded', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id, 'pub_1');
    const r = await requestRefund(w.deps, {
      unit_id: u.id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    expect(await failing()).toEqual([]);
  });
});

describe('INV7 fails on injected drift', () => {
  it('an extra sale row injected on one unit fails INV7 naming that publisher in one pass', async () => {
    w = await makeWorld();
    const a = await partialPack();
    const quayside = await unitOf(a.order_id, 'pub_2');
    // PO2 was declined: the unit was never verified and nothing is booked for it
    expect(await w.rows('SELECT 1 FROM ledger_entries WHERE unit_id = $1', [quayside.id])).toEqual(
      [],
    );
    const cap = await captureFor(quayside, 'FAKECAPQ');
    await injectLedger(quayside.id, cap, 'sale', 250, null);
    const found = await inv7();
    expect(found.ok).toBe(false);
    expect(found.detail).toContain('pub_2');
    expect(found.detail).toContain('difference 250');
    expect(found.detail).not.toContain('pub_1');
    expect(await failing()).toContain('INV7');
  });

  it('drift on both publishers is named in the same report', async () => {
    w = await makeWorld();
    const a = await partialPack();
    const harbour = await unitOf(a.order_id, 'pub_1');
    const quayside = await unitOf(a.order_id, 'pub_2');
    const cap = await captureFor(quayside, 'FAKECAPQ');
    await injectLedger(quayside.id, cap, 'sale', 250, null);
    // a refund row the unit does not know about (refunded_minor stays 0)
    await injectLedger(harbour.id, harbour.capture_id as string, 'refund', 60, 'RFGHOST');
    const found = await inv7();
    expect(found.ok).toBe(false);
    expect(found.detail).toContain('pub_1');
    expect(found.detail).toContain('pub_2');
    expect(found.detail).toContain('difference -60');
    expect(found.detail).toContain('difference 250');
  });

  it('a refunded amount on a unit that the ledger does not show fails INV7 for its publisher only', async () => {
    w = await makeWorld();
    const a = await paid(w, PACK);
    await w.rows(
      "UPDATE order_units SET refunded_minor = 100, status = 'partially_refunded' WHERE order_id = $1 AND publisher_id = 'pub_2'",
      [a.order_id],
    );
    const found = await inv7();
    expect(found.ok).toBe(false);
    expect(found.detail).toContain('pub_2');
    expect(found.detail).not.toContain('pub_1');
    expect(found.detail).toContain('difference 100');
  });

  it('a ledger sale on a publisher with no verified unit at all is a violation', async () => {
    w = await makeWorld();
    const a = await partialPack();
    const quayside = await unitOf(a.order_id, 'pub_2');
    const cap = await captureFor(quayside, 'FAKECAPQ2');
    await injectLedger(quayside.id, cap, 'sale', 100, null);
    await injectLedger(quayside.id, cap, 'refund', 30, 'RFQ');
    // net 70 on the ledger, 0 verified: the difference is the ledger's 70
    expect((await inv7()).detail).toContain('difference 70');
  });

  it('a capture id on two units fails INV7', async () => {
    w = await makeWorld();
    const a = await partialPack();
    const harbour = await unitOf(a.order_id, 'pub_1');
    const quayside = await unitOf(a.order_id, 'pub_2');
    // The database refuses this (order_units.capture_id is UNIQUE). The disposable test world drops
    // the constraint to prove the invariant would catch it if the constraint were ever lost.
    await w.rows('ALTER TABLE order_units DROP CONSTRAINT order_units_capture_id_key');
    try {
      await w.rows('UPDATE order_units SET capture_id = $2 WHERE id = $1', [
        quayside.id,
        harbour.capture_id,
      ]);
      const found = await inv7();
      expect(found.ok).toBe(false);
      expect(found.detail).toContain(harbour.capture_id as string);
      expect(found.detail).toMatch(/2 units/);
    } finally {
      await w.rows('UPDATE order_units SET capture_id = $2 WHERE id = $1', [
        quayside.id,
        quayside.capture_id,
      ]);
      await w.rows(
        'ALTER TABLE order_units ADD CONSTRAINT order_units_capture_id_key UNIQUE (capture_id)',
      );
    }
  });
});
