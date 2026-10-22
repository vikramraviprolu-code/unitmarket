// State tests of the offline refund path and the reversal rule (lane 05b). Refunds are read back
// from PayPal before the ledger books them; the amount comes from GET refund; only an operator
// asks. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { executeRefund, reconcileOrder, requestRefund, runDue, suspectReversal } from './index';
import {
  BUYER_A,
  OPERATOR,
  alertKinds,
  count,
  makeWorld,
  ops,
  orderStatus,
  paid,
  place,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const usd = (minor: number) => ({ currency: 'USD', minor });
const unitOf = async (order_id: string) =>
  (
    await w.rows<{
      id: string;
      status: string;
      refunded_minor: number;
      capture_id: string;
      amount_minor: number;
    }>(
      'SELECT id, status, refunded_minor, capture_id, amount_minor FROM order_units WHERE order_id = $1',
      [order_id],
    )
  )[0]!;
const ent = async (order_id: string) =>
  (
    await w.rows<{ money_state: string; access_state: string; licence_state: string | null }>(
      `SELECT e.money_state, e.access_state, e.licence_state FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
      [order_id],
    )
  )[0]!;
const window = async (order_id: string) =>
  (
    await w.rows<{ state: string }>(
      `SELECT a.state FROM access_windows a JOIN entitlements e ON e.id = a.entitlement_id JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
      [order_id],
    )
  )[0]!.state;
const refundEntries = () =>
  w.rows<{ refund_id: string; amount_minor: number; kind: string }>(
    "SELECT refund_id, amount_minor, kind FROM ledger_entries WHERE kind = 'refund' ORDER BY created_at, id",
  );

async function refund(unit_id: string, minor: number | null, reason = 'goodwill') {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason,
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.refund_request_id;
}

describe('requestRefund', () => {
  it('refund by a buyer actor refused, and nothing is stored', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    for (const actor of [
      BUYER_A,
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'system' },
    ] as const) {
      const r = await requestRefund(w.deps, {
        unit_id: u.id,
        amount: usd(100),
        reason: 'x',
        actor,
      });
      expect(r).toEqual({ ok: false, error: { code: 'not_operator' } });
    }
    expect(await count(w, 'refund_requests')).toBe(0);
    expect(w.refundCalls).toHaveLength(0);
  });
  it('refunds_enabled off: refused', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.switches.refunds_enabled = false;
    const r = await requestRefund(w.deps, {
      unit_id: (await unitOf(a.order_id)).id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'refunds_off' } });
  });
  it('a unit that is not captured and verified cannot be refunded', async () => {
    w = await makeWorld();
    const p = await place(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [p.order_id])
    )[0]!;
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_captured' } });
    const missing = await requestRefund(w.deps, {
      unit_id: 'unt_missing',
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(missing).toEqual({ ok: false, error: { code: 'not_captured' } });
  });
  it('over-refund refused: more than captured minus refunded, in-flight requests counted', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const ask = (minor: number) =>
      requestRefund(w.deps, { unit_id: u.id, amount: usd(minor), reason: 'x', actor: OPERATOR });
    expect(await ask(401)).toEqual({ ok: false, error: { code: 'over_refund' } });
    expect((await ask(400)).ok).toBe(true); // the whole amount, requested, not yet executed
    expect(await ask(1)).toEqual({ ok: false, error: { code: 'over_refund' } });
    expect(await count(w, 'refund_requests')).toBe(1);
  });
  it('zero, negative-looking and foreign-currency amounts are refused', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const zero = await requestRefund(w.deps, {
      unit_id: u.id,
      amount: usd(0),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(zero).toEqual({ ok: false, error: { code: 'over_refund' } });
    const eur = await requestRefund(w.deps, {
      unit_id: u.id,
      amount: { currency: 'EUR', minor: 100 },
      reason: 'x',
      actor: OPERATOR,
    });
    expect(eur).toEqual({ ok: false, error: { code: 'over_refund' } });
  });
  it('null means the whole remaining amount, fixed at request time', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const first = await refund(u.id, 100);
    await executeRefund(w.deps, { refund_request_id: first });
    const rest = await refund(u.id, null);
    const row = (
      await w.rows<{ amount_minor: number }>(
        'SELECT amount_minor FROM refund_requests WHERE id = $1',
        [rest],
      )
    )[0]!;
    expect(row.amount_minor).toBe(300);
  });
});

describe('executeRefund', () => {
  it('partial then full refund: two ledger entries by refund id, access revoked after full (C-06 offline twin)', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r1 = await refund(u.id, 100);
    const e1 = await executeRefund(w.deps, { refund_request_id: r1 });
    expect(e1).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    // Provider call used the derived key.
    expect(w.refundCalls[0]!.request_id).toBe(`umsR-${r1}`);
    expect((await refundEntries()).map((e) => e.amount_minor)).toEqual([100]);
    expect(await unitOf(a.order_id)).toMatchObject({
      status: 'partially_refunded',
      refunded_minor: 100,
    });
    // A partial refund leaves the access alone.
    expect(await ent(a.order_id)).toMatchObject({
      money_state: 'captured',
      access_state: 'available',
    });
    expect(await window(a.order_id)).toBe('running');

    const r2 = await refund(u.id, null);
    expect((await executeRefund(w.deps, { refund_request_id: r2 })).ok).toBe(true);
    const entries = await refundEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.amount_minor)).toEqual([100, 300]);
    expect(new Set(entries.map((e) => e.refund_id)).size).toBe(2);
    expect(await unitOf(a.order_id)).toMatchObject({ status: 'refunded', refunded_minor: 400 });
    expect(await ent(a.order_id)).toMatchObject({
      money_state: 'refunded',
      access_state: 'revoked',
      licence_state: 'terminated',
    });
    expect(await window(a.order_id)).toBe('revoked');
    // The sale stays; the receipt shows the refunds.
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    const receipt = (
      await w.rows<{ body: { refunds?: unknown } }>(
        'SELECT body FROM receipts ORDER BY version DESC LIMIT 1',
      )
    )[0]!;
    expect(JSON.stringify(receipt.body)).toContain('refund');
  });
  it('the same refund request executed twice makes one provider call and one ledger entry', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    const again = await executeRefund(w.deps, { refund_request_id: r1 });
    expect(again).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(w.refundCalls).toHaveLength(1);
    expect(await refundEntries()).toHaveLength(1);
  });
  it('a refund is booked only after the read shows it: GET refund says PENDING, nothing is booked yet', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.refundNext.status = 'COMPLETED';
    w.refundNext.read_status = 'PENDING';
    const r1 = await refund(u.id, 100);
    expect(await executeRefund(w.deps, { refund_request_id: r1 })).toEqual({
      ok: true,
      value: { status: 'PENDING' },
    });
    expect(await refundEntries()).toHaveLength(0);
    expect((await unitOf(a.order_id)).refunded_minor).toBe(0);
    // It stays under watch and books when PayPal says COMPLETED.
    expect(
      (await ops(w, a.order_id)).some((o) => o.kind === 'refund_readback' && o.state === 'unknown'),
    ).toBe(true);
    w.refundNext.read_status = null;
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await refundEntries()).toHaveLength(1);
    expect((await unitOf(a.order_id)).refunded_minor).toBe(100);
    expect((await ops(w, a.order_id)).filter((o) => o.kind === 'refund_readback')[0]!.state).toBe(
      'confirmed',
    );
    await runDue(w.deps, { max_items: 10 });
    expect(await refundEntries()).toHaveLength(1);
  });
  it('the amount is taken from GET refund, not from the request or the capture read', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.refundNext.read_minor = 90;
    const r1 = await refund(u.id, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    expect((await refundEntries()).map((e) => e.amount_minor)).toEqual([90]);
    expect((await unitOf(a.order_id)).refunded_minor).toBe(90);
  });
  it('PayPal refuses the refund: rejected, nothing booked, the request is closed', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.reject = true;
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    expect(await executeRefund(w.deps, { refund_request_id: r1 })).toEqual({
      ok: false,
      error: { code: 'rejected' },
    });
    expect(await refundEntries()).toHaveLength(0);
    expect((await ops(w, a.order_id)).find((o) => o.kind === 'refund')!.state).toBe('failed');
    expect((await w.rows<{ state: string }>('SELECT state FROM refund_requests'))[0]!.state).toBe(
      'rejected',
    );
    // The room is free again.
    const retry = await requestRefund(w.deps, {
      unit_id: (await unitOf(a.order_id)).id,
      amount: usd(400),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(retry.ok).toBe(true);
  });
  it('a refund that FAILED at PayPal is not booked and raises refund_failed', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.status = 'FAILED';
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    expect(await executeRefund(w.deps, { refund_request_id: r1 })).toEqual({
      ok: true,
      value: { status: 'FAILED' },
    });
    expect(await refundEntries()).toHaveLength(0);
    expect(await alertKinds(w, a.order_id)).toContain('refund_failed');
  });
  it('the answer is lost: the same key is sent again inside 5 h and the refund is booked once', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.refundNext.lose_response = true;
    const r1 = await refund(u.id, 100);
    expect(await executeRefund(w.deps, { refund_request_id: r1 })).toEqual({
      ok: false,
      error: { code: 'unknown' },
    });
    w.refundNext.lose_response = false;
    expect(await refundEntries()).toHaveLength(0);
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.refundCalls).toHaveLength(2);
    expect(w.refundCalls[1]!.request_id).toBe(w.refundCalls[0]!.request_id);
    expect(w.refunds.size).toBe(1); // PayPal saw one refund
    expect(await refundEntries()).toHaveLength(1);
    expect((await unitOf(a.order_id)).refunded_minor).toBe(100);
  });
  it('the answer is lost and 5 h pass: no resend, the refund is flagged for a human', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.lose_response = true;
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    w.tick(5 * H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect(w.refundCalls).toHaveLength(1);
    expect((await ops(w, a.order_id)).find((o) => o.kind === 'refund')).toMatchObject({
      state: 'failed',
      failure_reason: 'window_expired',
    });
    expect(await alertKinds(w, a.order_id)).toContain('refund_unresolved');
    expect(await refundEntries()).toHaveLength(0);
  });
  it('the switch is re-read at execution: refunds off means no call', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    w.switches.refunds_enabled = false;
    expect((await executeRefund(w.deps, { refund_request_id: r1 })).ok).toBe(false);
    expect(w.refundCalls).toHaveLength(0);
    w.switches.refunds_enabled = true;
    expect((await executeRefund(w.deps, { refund_request_id: r1 })).ok).toBe(true);
    expect(w.refundCalls).toHaveLength(1);
  });
  it('an unknown refund request id is an error result', async () => {
    w = await makeWorld();
    expect(await executeRefund(w.deps, { refund_request_id: 'rfr_missing' })).toEqual({
      ok: false,
      error: { code: 'rejected' },
    });
  });
  it('two executions racing make one provider call and one ledger entry', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    await Promise.all([
      executeRefund(w.deps, { refund_request_id: r1 }),
      executeRefund(w.deps, { refund_request_id: r1 }),
    ]);
    expect(w.refundCalls).toHaveLength(1);
    expect(await refundEntries()).toHaveLength(1);
  });
});

describe('refunds seen by a read', () => {
  it('a refund made at the PayPal dashboard is flagged once; a full one revokes access', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.dashboardRefund(u.capture_id, 150);
    w.tick(H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect(await alertKinds(w, a.order_id)).toEqual(['refund_unbooked']);
    expect(await ent(a.order_id)).toMatchObject({ money_state: 'captured' });
    w.dashboardRefund(u.capture_id, 250);
    w.tick(H + 1000);
    await runDue(w.deps, { max_items: 10 });
    expect(await ent(a.order_id)).toMatchObject({
      money_state: 'refunded',
      access_state: 'revoked',
    });
    expect(await count(w, 'alerts', "kind = 'refund_unbooked'")).toBe(2);
    expect(await refundEntries()).toHaveLength(0);
    expect(await orderStatus(w, a.order_id)).toBe('paid');
  });
  it('our own refund seen mid-flight does not raise the dashboard alert', async () => {
    w = await makeWorld();
    const a = await paid(w);
    w.refundNext.status = 'COMPLETED';
    w.refundNext.read_status = 'PENDING';
    const r1 = await refund((await unitOf(a.order_id)).id, 100);
    await executeRefund(w.deps, { refund_request_id: r1 });
    await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' });
    expect(await alertKinds(w, a.order_id)).toEqual([]);
  });
});

describe('reversal', () => {
  it('reversal event gives reversal_suspected and an alert, not reversed', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r = await suspectReversal(w.deps, { capture_id: u.capture_id, source: 'webhook' });
    expect(r).toEqual({ found: true, changed: true });
    expect((await unitOf(a.order_id)).status).toBe('reversal_suspected');
    expect(await alertKinds(w, a.order_id)).toEqual(['reversal']);
    // Nothing is reversed until an operator confirms.
    expect(await ent(a.order_id)).toMatchObject({
      money_state: 'captured',
      access_state: 'available',
    });
    expect(await count(w, 'ledger_entries', "kind = 'reversal'")).toBe(0);
    // A repeat of the event changes nothing and raises nothing.
    expect(await suspectReversal(w.deps, { capture_id: u.capture_id, source: 'webhook' })).toEqual({
      found: true,
      changed: false,
    });
    expect(await count(w, 'alerts', "kind = 'reversal'")).toBe(1);
  });
  it('an unknown capture id changes nothing', async () => {
    w = await makeWorld();
    await paid(w);
    expect(await suspectReversal(w.deps, { capture_id: 'NOPE', source: 'webhook' })).toEqual({
      found: false,
      changed: false,
    });
    expect(await count(w, 'alerts')).toBe(0);
  });
  it('a read that shows a verified capture as DECLINED marks it reversal_suspected', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    w.forceStatus(u.capture_id, 'DECLINED');
    const r = await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' });
    expect('skipped' in r).toBe(false);
    expect((await unitOf(a.order_id)).status).toBe('reversal_suspected');
    expect(await alertKinds(w, a.order_id)).toEqual(['reversal']);
    expect(await ent(a.order_id)).toMatchObject({ money_state: 'captured' });
  });
  it('a refunded unit is not marked as reversal by the event path', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    await executeRefund(w.deps, { refund_request_id: await refund(u.id, null) });
    const r = await suspectReversal(w.deps, { capture_id: u.capture_id, source: 'webhook' });
    expect(r.found).toBe(true);
    expect((await unitOf(a.order_id)).status).toBe('refunded');
  });
});
