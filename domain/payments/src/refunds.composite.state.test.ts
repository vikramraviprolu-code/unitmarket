// DP-3 (MVP-D, OQ-10): a refund of one unit of a pack reads the unit's OWN PayPal order, never the
// first one of the order; a refund never changes the other unit; a partial refund never revokes
// (ASM-61); a frozen sibling PayPal order does not block the refund of a captured unit. A pack is the
// approval of ofr_1 (publisher 1, "Harbour") and ofr_3 (publisher 2, "Quayside"): two units of 4.00,
// two PayPal orders, one capture each. The refund path itself is unchanged (N refunds for N units).
// Real PGlite, scripted PayPal. Synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkInvariants,
  executeRefund,
  onBuyerReturn,
  reconcileOrder,
  requestRefund,
  runDue,
} from './index';
import { OPERATOR, alertKinds, approved, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';
import { providerOrdersOf } from './support';

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const SEC = 1_000;
const H = 3_600 * SEC;
const PACK = { offers: ['ofr_1', 'ofr_3'] };
const usd = (minor: number) => ({ currency: 'USD', minor });

interface PackUnit {
  id: string;
  publisher_id: string;
  capture_id: string | null;
  amount_minor: number;
  /** The PayPal order id (PayPal's own) of the unit's own PayPal order. */
  po: string;
}
/** Harbour is publisher 1, Quayside publisher 2; each has its own PayPal order. */
async function pack(
  tweak?: (poIds: string[]) => void,
): Promise<{ order_id: string; harbour: PackUnit; quayside: PackUnit; poIds: string[] }> {
  w = await makeRemainingWorld();
  const a = await (async () => {
    // The tweak needs the PayPal order ids, which exist only after the checkout begins.
    if (tweak === undefined) return paid(w, PACK);
    const x = await approved(w, PACK);
    const ids = x.provider_orders.map((p) => p.provider_order_id as string);
    tweak(ids);
    await onBuyerReturn(w.deps, {
      order_ref: x.order_ref,
      actor: { kind: 'buyer', buyer_id: 'buy_A' },
    });
    return x;
  })();
  const units = await w.rows<PackUnit>(
    `SELECT u.id, u.publisher_id, u.capture_id, u.amount_minor, p.provider_order_id AS po
       FROM order_units u JOIN provider_orders p ON p.id = u.provider_order_ref
      WHERE u.order_id = $1 ORDER BY u.publisher_id`,
    [a.order_id],
  );
  const poIds = (await providerOrdersOf(w, a.order_id)).map((p) => p.provider_order_id as string);
  expect(units).toHaveLength(2);
  expect(new Set(units.map((u) => u.po)).size).toBe(2);
  return { order_id: a.order_id, harbour: units[0]!, quayside: units[1]!, poIds };
}

async function request(unit_id: string, minor: number | null): Promise<string> {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.refund_request_id;
}
const run = (id: string) => executeRefund(w.deps, { refund_request_id: id });
const reqRow = async (id: string) =>
  (
    await w.rows<{ state: string; refund_id: string | null; amount_minor: number }>(
      'SELECT state, refund_id, amount_minor FROM refund_requests WHERE id = $1',
      [id],
    )
  )[0]!;
const unitRow = async (id: string) =>
  (
    await w.rows<{ status: string; refunded_minor: number }>(
      'SELECT status, refunded_minor FROM order_units WHERE id = $1',
      [id],
    )
  )[0]!;
/** Every column of the rows that belong to a unit, for "untouched" (updated_at included). */
async function snapshotOf(unit_id: string): Promise<unknown> {
  return {
    unit: await w.rows('SELECT * FROM order_units WHERE id = $1', [unit_id]),
    entitlements: await w.rows('SELECT * FROM entitlements WHERE unit_id = $1 ORDER BY id', [
      unit_id,
    ]),
    ledger: await w.rows('SELECT * FROM ledger_entries WHERE unit_id = $1 ORDER BY id', [unit_id]),
    requests: await w.rows('SELECT * FROM refund_requests WHERE unit_id = $1 ORDER BY id', [
      unit_id,
    ]),
  };
}
const entitlementsOf = (unit_id: string) =>
  w.rows<{ money_state: string; access_state: string }>(
    'SELECT money_state, access_state FROM entitlements WHERE unit_id = $1 ORDER BY id',
    [unit_id],
  );
const reads = (since: number) => w.paypal.calls.slice(since).filter((c) => c.op === 'get');
const invariantsHold = async () =>
  expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);

describe('a refund reads the unit own PayPal order', () => {
  it('refund of the Quayside unit reads the Quayside PayPal order, not the first one (check, send and read-back)', async () => {
    const { quayside, harbour } = await pack();
    expect(quayside.po).not.toBe(harbour.po);
    const base = w.paypal.calls.length;
    const rq = await request(quayside.id, null);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    // booked: the read-back found the Quayside capture, which only the Quayside order lists
    expect((await reqRow(rq)).state).toBe('completed');
    expect(await unitRow(quayside.id)).toEqual({ status: 'refunded', refunded_minor: 400 });
    // every order read of the refund went to the Quayside order; the first order was never read
    const seen = reads(base);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(seen.map((c) => c.provider_order_id))]).toEqual([quayside.po]);
    await invariantsHold();
  });

  it('refund of the Harbour unit reads the Harbour PayPal order', async () => {
    const { quayside, harbour } = await pack();
    const base = w.paypal.calls.length;
    const rq = await request(harbour.id, 150);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(await unitRow(harbour.id)).toEqual({
      status: 'partially_refunded',
      refunded_minor: 150,
    });
    expect([...new Set(reads(base).map((c) => c.provider_order_id))]).toEqual([harbour.po]);
    expect(reads(base).some((c) => c.provider_order_id === quayside.po)).toBe(false);
  });

  it('the 24 h close of a lost refund answer reads the Quayside order and proves it failed (not unresolved)', async () => {
    const { order_id, quayside } = await pack();
    // The refund call is lost and never reaches PayPal.
    w.paypal.refundCapture = (r) => {
      w.refundCalls.push({ request_id: r.request_id, capture_id: r.capture_id, amount: r.amount });
      return Promise.resolve({ kind: 'timeout' as const });
    };
    const rq = await request(quayside.id, 200);
    expect((await run(rq)).ok).toBe(false);
    expect((await reqRow(rq)).state).toBe('unknown');
    w.tick(25 * H); // past the 5 h key window and the 24 h window
    await runDue(w.deps, { max_items: 10 });
    // The Quayside order shows the capture with no refund: proven, so the request failed and its
    // reservation is freed. Reading the first order would show no such capture: unresolved.
    expect((await reqRow(rq)).state).toBe('failed');
    expect(await alertKinds(w, order_id)).toEqual([]);
    // (the same due pass also re-reads the other order for its own reasons; the state above decides)
    expect((await unitRow(quayside.id)).refunded_minor).toBe(0);
  });

  it('a unit whose PayPal order is not stored takes no read of another order (fails closed)', async () => {
    const { quayside, harbour } = await pack();
    await w.rows('UPDATE order_units SET provider_order_ref = NULL WHERE id = $1', [quayside.id]);
    const base = w.paypal.calls.length;
    const rq = await request(quayside.id, 100);
    // The check before the send cannot read the unit's order, so nothing is sent.
    expect((await run(rq)).ok).toBe(false);
    expect(w.sends()).toHaveLength(0);
    expect(reads(base).some((c) => c.provider_order_id === harbour.po)).toBe(false);
    expect((await reqRow(rq)).state).toBe('requested');
  });
});

describe('a refund of one publisher changes only that unit', () => {
  it('refund of one publisher leaves the other unit, its entitlements and its ledger untouched', async () => {
    const { harbour, quayside, order_id } = await pack();
    const otherBefore = await snapshotOf(harbour.id);
    const poBefore = await w.rows(
      'SELECT * FROM provider_orders WHERE order_id = $1 ORDER BY position',
      [order_id],
    );
    const rq = await request(quayside.id, null);
    await run(rq);
    expect(await unitRow(quayside.id)).toEqual({ status: 'refunded', refunded_minor: 400 });
    expect(await snapshotOf(harbour.id)).toEqual(otherBefore);
    expect(
      await w.rows('SELECT * FROM provider_orders WHERE order_id = $1 ORDER BY position', [
        order_id,
      ]),
    ).toEqual(poBefore);
    // the refund is one ledger row on the Quayside capture, none on the Harbour one
    const rows = await w.rows<{ unit_id: string; kind: string }>(
      "SELECT unit_id, kind FROM ledger_entries WHERE kind = 'refund'",
    );
    expect(rows).toEqual([{ unit_id: quayside.id, kind: 'refund' }]);
    await invariantsHold();
  });

  it('full refund of the Harbour unit revokes only Harbour items', async () => {
    const { harbour, quayside } = await pack();
    const quaysideBefore = await snapshotOf(quayside.id);
    const rq = await request(harbour.id, null);
    await run(rq);
    expect(await unitRow(harbour.id)).toEqual({ status: 'refunded', refunded_minor: 400 });
    expect((await entitlementsOf(harbour.id)).map((e) => e.money_state)).toEqual(['refunded']);
    expect((await entitlementsOf(harbour.id)).map((e) => e.access_state)).toEqual(['revoked']);
    expect(await snapshotOf(quayside.id)).toEqual(quaysideBefore);
    expect((await entitlementsOf(quayside.id)).map((e) => e.access_state)).toEqual(['available']);
    await invariantsHold();
  });

  it('partial refund of a unit does not revoke (ASM-61)', async () => {
    const { harbour, quayside, order_id } = await pack();
    const before = await entitlementsOf(quayside.id);
    const rq = await request(quayside.id, 100);
    await run(rq);
    expect(await unitRow(quayside.id)).toEqual({
      status: 'partially_refunded',
      refunded_minor: 100,
    });
    expect(await entitlementsOf(quayside.id)).toEqual(before);
    expect((await entitlementsOf(quayside.id)).map((e) => e.access_state)).toEqual(['available']);
    expect((await entitlementsOf(harbour.id)).map((e) => e.access_state)).toEqual(['available']);
    const o = await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      order_id,
    ]);
    expect(o[0]?.status).toBe('paid');
    // the rest can be refunded later and only then does access end
    const rest = await request(quayside.id, null);
    expect((await reqRow(rest)).amount_minor).toBe(300);
    await run(rest);
    expect((await entitlementsOf(quayside.id)).map((e) => e.access_state)).toEqual(['revoked']);
    await invariantsHold();
  });
});

describe('a frozen sibling PayPal order', () => {
  /** Quayside's PayPal order is captured and then found to pay the wrong payee: it is frozen. */
  async function frozenSibling() {
    const p = await pack((ids) => {
      w.paypal.tamperAfterCapture.set(ids[1]!, { payee: 'SBXEVILPAYEE' });
    });
    const states = (await providerOrdersOf(w, p.order_id)).map((x) => x.state);
    expect(states).toEqual(['captured', 'frozen']);
    expect(
      (
        await w.rows<{ mismatch: boolean }>('SELECT mismatch FROM orders WHERE id = $1', [
          p.order_id,
        ])
      )[0]!.mismatch,
    ).toBe(true);
    return p;
  }

  it('a frozen sibling provider order does not block this refund', async () => {
    const { harbour, quayside, order_id } = await frozenSibling();
    const frozenBefore = await snapshotOf(quayside.id);
    const base = w.paypal.calls.length;
    const rq = await request(harbour.id, null); // not unit_frozen
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(await unitRow(harbour.id)).toEqual({ status: 'refunded', refunded_minor: 400 });
    expect([...new Set(reads(base).map((c) => c.provider_order_id))]).toEqual([harbour.po]);
    // the held unit is untouched, and nothing here clears the hold
    expect(await snapshotOf(quayside.id)).toEqual(frozenBefore);
    expect((await providerOrdersOf(w, order_id)).map((x) => x.state)).toEqual([
      'captured',
      'frozen',
    ]);
    expect(
      (
        await w.rows<{ mismatch: boolean }>('SELECT mismatch FROM orders WHERE id = $1', [order_id])
      )[0]!.mismatch,
    ).toBe(true);
  });

  it('the held unit itself takes no refund (it holds no verified capture)', async () => {
    const { quayside } = await frozenSibling();
    const r = await requestRefund(w.deps, {
      unit_id: quayside.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_captured' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
  });

  it('a refund list that does not add up still freezes the whole order, sibling or not', async () => {
    const { harbour, order_id } = await frozenSibling();
    // PayPal lists more refunds than were captured on the Harbour capture: the list is not trusted.
    w.dashboard(harbour.capture_id as string, 900);
    await reconcileOrder(w.deps, { order_id, trigger: 'poll' });
    const alerts = await w.rows<{ reason: string; source: string | null }>(
      "SELECT detail ->> 'reason' AS reason, detail ->> 'source' AS source FROM alerts WHERE kind = 'frozen_order'",
    );
    expect(alerts.some((a) => a.source === 'refund_list')).toBe(true);
    const r = await requestRefund(w.deps, {
      unit_id: harbour.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unit_frozen' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
  });

  it('a hold on the unit own PayPal order still blocks (the flag is not explained by the sibling)', async () => {
    const { harbour, order_id } = await frozenSibling();
    // The Harbour order is frozen too (both held): its captured unit takes no new request.
    await w.rows("UPDATE provider_orders SET state = 'frozen' WHERE order_id = $1", [order_id]);
    const r = await requestRefund(w.deps, {
      unit_id: harbour.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unit_frozen' } });
  });

  it('a unit with no stored PayPal order cannot be shown to be clear of the hold: it stays blocked', async () => {
    const { harbour } = await frozenSibling();
    await w.rows('UPDATE order_units SET provider_order_ref = NULL WHERE id = $1', [harbour.id]);
    const r = await requestRefund(w.deps, {
      unit_id: harbour.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unit_frozen' } });
  });

  it('a single-route order keeps the old rule: any mismatch flag blocks', async () => {
    w = await makeRemainingWorld();
    const a = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!;
    await w.rows('UPDATE orders SET mismatch = true WHERE id = $1', [a.order_id]);
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unit_frozen' } });
  });
});

describe('a refund never goes beyond the unit, to a unit that took no money, or twice', () => {
  it('a refund over the unit own remaining amount is refused even though the order holds more', async () => {
    const { quayside } = await pack();
    const r = await requestRefund(w.deps, {
      unit_id: quayside.id,
      amount: usd(401), // the order paid 8.00, this unit 4.00
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'over_refund' } });
    const ok = await request(quayside.id, 250);
    await run(ok);
    const again = await requestRefund(w.deps, {
      unit_id: quayside.id,
      amount: usd(151),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(again).toEqual({ ok: false, error: { code: 'over_refund' } });
    expect(w.sends()).toHaveLength(1);
  });

  it('a declined or uncaptured unit of a partial pack takes no refund request and nothing is sent', async () => {
    w = await makeRemainingWorld();
    const x = await approved(w, PACK);
    w.paypal.nextBy.set(x.provider_orders[1]!.provider_order_id as string, {
      status: 'DECLINED',
      fee: null,
    });
    await onBuyerReturn(w.deps, {
      order_ref: x.order_ref,
      actor: { kind: 'buyer', buyer_id: 'buy_A' },
    });
    const units = await w.rows<{ id: string; status: string }>(
      'SELECT id, status FROM order_units WHERE order_id = $1 ORDER BY publisher_id',
      [x.order_id],
    );
    expect(units.map((u) => u.status)).toEqual(['captured_verified', 'declined']);
    const r = await requestRefund(w.deps, {
      unit_id: units[1]!.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_captured' } });
    expect(w.sends()).toHaveLength(0);
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
    // the captured unit of the same partial pack refunds normally, on its own PayPal order
    const rq = await request(units[0]!.id, null);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(w.sends()).toHaveLength(1);
  });

  it('CO-8 idempotency holds on a pack: executing the same request twice sends one refund', async () => {
    const { quayside } = await pack();
    const rq = await request(quayside.id, null);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(w.sends()).toHaveLength(1);
    expect(
      await w.rows("SELECT 1 FROM ledger_entries WHERE kind = 'refund' AND unit_id = $1", [
        quayside.id,
      ]),
    ).toHaveLength(1);
    // a second request for the refunded unit has nothing left to refund
    const again = await requestRefund(w.deps, {
      unit_id: quayside.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(again.ok).toBe(false);
  });

  it('one request per unit: both units can be refunded, each by its own request and its own send', async () => {
    const { harbour, quayside } = await pack();
    const a = await request(harbour.id, null);
    const b = await request(quayside.id, null); // the other unit is not "in flight"
    expect(await run(a)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(await run(b)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    const sent = w.sends();
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.capture_id)).size).toBe(2);
    expect((await unitRow(harbour.id)).status).toBe('refunded');
    expect((await unitRow(quayside.id)).status).toBe('refunded');
    await invariantsHold();
  });
});
