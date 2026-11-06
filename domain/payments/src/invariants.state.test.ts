// State tests of the four invariants (lane 05b, P11): they pass after every scenario and fail on
// injected drift. Read-only SQL over the real rows; PGlite.
import { afterEach, describe, expect, it } from 'vitest';
import { checkInvariants, executeRefund, requestRefund, runDue } from './index';
import {
  OPERATOR,
  approved,
  awaiting,
  deadCapture,
  lostResponse,
  makeWorld,
  paid,
  place,
  sentCapture,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const failing = async (): Promise<string[]> =>
  (await checkInvariants(w.db)).filter((r) => !r.ok).map((r) => r.id);
const unit = async (order_id: string) =>
  (await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [order_id]))[0]!
    .id;

describe('checkInvariants passes after every scenario', () => {
  it('reports the eight invariants, in order, with a detail line each', async () => {
    w = await makeWorld();
    const r = await checkInvariants(w.db);
    expect(r.map((x) => x.id)).toEqual([
      'INV1',
      'INV2',
      'INV3',
      'INV4',
      'INV5',
      'INV6',
      'INV7',
      'INV8',
    ]);
    expect(r.every((x) => x.ok && x.detail.length > 0)).toBe(true);
  });
  it('after a paid order, a failed order, a waiting order and an open capture', async () => {
    w = await makeWorld();
    await paid(w);
    await awaiting(w, { buyer_id: 'buy_B' });
    await place(w, { offers: ['ofr_2'] });
    await lostResponse(w, { offers: ['ofr_3'] });
    await sentCapture(w, { offers: ['ofr_2'], buyer_id: 'buy_B' });
    await deadCapture(w, { offers: ['ofr_3'], buyer_id: 'buy_B' });
    expect(await failing()).toEqual([]);
    w.tick(10 * 60_000);
    await runDue(w.deps, { max_items: 50 });
    expect(await failing()).toEqual([]);
  });
  it('after an abandoned checkout and a frozen order', async () => {
    w = await makeWorld();
    await awaiting(w);
    const a = await approved(w, { buyer_id: 'buy_B' });
    w.paypal.tamper = { amount_delta: 1 };
    w.tick(25 * 3_600_000);
    await runDue(w.deps, { max_items: 50 });
    expect(a).toBeDefined();
    expect(await failing()).toEqual([]);
  });
  it('after a partial and a full refund', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unit(a.order_id);
    for (const minor of [100, null]) {
      const r = await requestRefund(w.deps, {
        unit_id: u,
        amount: minor === null ? null : { currency: 'USD', minor },
        reason: 'x',
        actor: OPERATOR,
      });
      if (!r.ok) throw new Error('refused');
      await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
      expect(await failing()).toEqual([]);
    }
  });
  it('after a suspected reversal', async () => {
    w = await makeWorld();
    const a = await paid(w);
    await w.db.query("UPDATE order_units SET status = 'reversal_suspected' WHERE order_id = $1", [
      a.order_id,
    ]);
    expect(await failing()).toEqual([]);
  });
});

describe('checkInvariants fails on injected drift', () => {
  it('INV1: a refunded amount with no refund entry in the ledger', async () => {
    w = await makeWorld();
    const a = await paid(w);
    await w.db.query(
      "UPDATE order_units SET refunded_minor = 100, status = 'partially_refunded' WHERE order_id = $1",
      [a.order_id],
    );
    // INV7 (DP-4) sees the same drift per publisher: the unit says 100 went back, the ledger does not.
    expect(await failing()).toEqual(['INV1', 'INV7']);
    const inv1 = (await checkInvariants(w.db)).find((r) => r.id === 'INV1')!;
    expect(inv1.detail).toContain(await unit(a.order_id));
  });
  it('INV1: a verified unit with no sale entry', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    await w.db.query(
      "UPDATE order_units SET status = 'captured_verified', capture_id = 'FAKECAP', captured_verified_at = '2026-10-22T10:00:00Z' WHERE order_id = $1",
      [a.order_id],
    );
    expect(await failing()).toContain('INV1');
  });
  it('INV1: a sale entry on a unit that was never verified', async () => {
    w = await makeWorld();
    const a = await paid(w);
    await w.db.query(
      "UPDATE order_units SET status = 'pending', captured_verified_at = NULL WHERE order_id = $1",
      [a.order_id],
    );
    expect(await failing()).toContain('INV1');
  });
  it('INV2: an available item whose capture is not verified', async () => {
    w = await makeWorld();
    const a = await paid(w);
    await w.db.query(
      "UPDATE order_units SET status = 'expected', captured_verified_at = NULL WHERE order_id = $1",
      [a.order_id],
    );
    expect(await failing()).toContain('INV2');
  });
  it('INV3: a verified unit whose item is still pending', async () => {
    w = await makeWorld();
    await paid(w);
    await w.db.query(
      "UPDATE entitlements SET money_state = 'pending', licence_state = NULL, access_state = 'locked'",
    );
    expect(await failing()).toEqual(['INV3']);
  });
  it('INV3: a verified unit with no item at all', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    const ids = (
      await w.rows<{ id: string }>(
        'SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1',
        [a.order_id],
      )
    ).map((r) => r.id);
    await w.db.query('DELETE FROM access_windows WHERE entitlement_id = ANY($1::text[])', [ids]);
    await w.db.query('DELETE FROM entitlements WHERE id = ANY($1::text[])', [ids]);
    await w.db.query(
      "UPDATE order_units SET status = 'captured_verified', capture_id = 'FAKECAP', captured_verified_at = '2026-10-22T10:00:00Z' WHERE order_id = $1",
      [a.order_id],
    );
    expect(await failing()).toContain('INV3');
  });
  it('INV4: a window whose end is not what the log gives', async () => {
    w = await makeWorld();
    await paid(w);
    await w.db.query("UPDATE access_windows SET ends_at = ends_at + interval '2 hours'");
    expect(await failing()).toEqual(['INV4']);
  });
  it('INV4: a window whose start is not what the log gives', async () => {
    w = await makeWorld();
    await paid(w);
    await w.db.query("UPDATE access_windows SET started_at = started_at + interval '1 hour'");
    expect(await failing()).toContain('INV4');
  });
});
