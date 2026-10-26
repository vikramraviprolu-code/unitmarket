// DP-2b (MVP-D, route D2): the background paths per PayPal order and the continuation after the first
// capture. Real PGlite, scripted PayPal. A pack is the approval of ofr_1 (publisher 1) and ofr_3
// (publisher 2): two units, two PayPal orders, one capture each. The rules under test are in
// docs/specs/mvp-d-dp2b-reconcile-continuation.md and docs/specs/mvp-d-overview.md section 3.
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureRes } from '@umsbx/contracts';
import {
  beginCheckout,
  checkInvariants,
  nextDueAt,
  onBuyerReturn,
  reconcileOrder,
  runDue,
} from './index';
import { retryCapture } from './reconcile';
import { loadOperation, loadOrder } from './store';
import { reapply } from './support';
import {
  BUYER_A,
  BUYER_B,
  approvePo,
  approved,
  awaiting,
  count,
  lostResponse,
  makeWorld,
  place,
  providerOrdersOf,
} from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const H = 3_600_000;
/** first_approved_at + pack_approval_window_ms (1 h) + reconcile_window_ms (24 h), plus a millisecond. */
const PAST_DEADLINE = 25 * H + 1;
const AGAIN = 'https://www.sandbox.paypal.com/checkoutnow?token=PO2AGAIN';
const DUPLICATE: CaptureRes = {
  kind: 'rejected',
  http: 422,
  name: 'UNPROCESSABLE_ENTITY',
  issue: 'DUPLICATE_INVOICE_ID',
  debug_id: 'D',
};
const ret = (ref: string, actor: typeof BUYER_A | typeof BUYER_B = BUYER_A) =>
  onBuyerReturn(w.deps, { order_ref: ref, actor });
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);
const states = async (order_id: string): Promise<string[]> =>
  (await providerOrdersOf(w, order_id)).map((p) => p.state);
const orderRow = async (id: string) =>
  (
    await w.rows<{ status: string; mismatch: boolean }>(
      'SELECT status, mismatch FROM orders WHERE id = $1',
      [id],
    )
  )[0]!;
const unitRows = (order_id: string) =>
  w.rows<{ publisher_id: string; status: string; status_reason: string | null }>(
    'SELECT publisher_id, status, status_reason FROM order_units WHERE order_id = $1 ORDER BY publisher_id',
    [order_id],
  );
const entRows = (order_id: string) =>
  w.rows<{ money_state: string; access_state: string }>(
    `SELECT e.money_state, e.access_state FROM entitlements e
       JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1 ORDER BY e.article_id`,
    [order_id],
  );
const alerts = (kind: string) =>
  w.rows<{ reason: string }>(
    "SELECT detail ->> 'reason' AS reason FROM alerts WHERE kind = $1 ORDER BY created_at, id",
    [kind],
  );
const capOps = (order_id: string) =>
  w.rows<{ request_id: string; state: string; first_sent_at: unknown }>(
    `SELECT o.request_id, o.state, o.first_sent_at FROM operations o
       JOIN provider_orders p ON p.id = o.provider_order_ref
      WHERE o.order_id = $1 AND o.kind = 'capture' ORDER BY p.position`,
    [order_id],
  );
const capCalls = () => w.paypal.calls.filter((c) => c.op === 'capture');
const callsOf = (id: string, op: 'get' | 'capture') =>
  w.paypal.calls.filter((c) => c.op === op && c.provider_order_id === id);
const sales = () => count(w, 'ledger_entries', "kind = 'sale'");
const failedInvariants = async () => (await checkInvariants(w.db)).filter((i) => !i.ok);
const pass = (max_items = 10) => runDue(w.deps, { max_items });

/**
 * The process dies between the two captures of a pack: PO1 is captured and read back, PO2 is approved
 * and nothing was sent for it (it dies at the status read of PO2, the 4th read of the return).
 */
async function crashBetweenCaptures(
  o: { buyer_id?: string; actor?: typeof BUYER_A | typeof BUYER_B } = {},
): Promise<Awaited<ReturnType<typeof approved>>> {
  const a = await approved(w, { ...PACK, ...o });
  const base = w.paypal.count('get');
  w.paypal.beforeGet = async () => {
    if (w.paypal.count('get') === base + 4) {
      w.paypal.beforeGet = null;
      throw new Error('process died between the captures');
    }
  };
  await expect(ret(a.order_ref, o.actor ?? BUYER_A)).rejects.toThrow('died between the captures');
  w.paypal.beforeGet = null;
  expect(await states(a.order_id)).toEqual(['captured', 'approved']);
  expect((await orderRow(a.order_id)).status).toBe('capture_requested');
  return a;
}

describe('the continuation: a pack whose first capture was sent always finishes', () => {
  it('crash after PO1 captured: the next due pass captures PO2 once with umsK-<ref>-p2', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    expect(capCalls()).toHaveLength(1);
    const before = w.paypal.calls.length;
    const r = await pass();
    expect(r.processed).toBe(1);
    // read it fresh, capture it with its own key, read it back
    expect(w.paypal.calls.slice(before).map((c) => [c.op, c.provider_order_id])).toEqual([
      ['get', poIds(a)[1]],
      ['capture', poIds(a)[1]],
      ['get', poIds(a)[1]],
    ]);
    expect(capCalls().map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p1`,
      `umsK-${a.order_ref}-p2`,
    ]);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect(await sales()).toBe(2);
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual([
      'available',
      'available',
    ]);
    expect(await alerts('partial_composite')).toEqual([]);
    // a second pass changes nothing
    const after = w.paypal.calls.length;
    expect((await pass()).processed).toBe(0);
    expect(w.paypal.calls.length).toBe(after);
    expect(await failedInvariants()).toEqual([]);
  });

  it('kill switch between the captures: after reset exactly one PO2 capture', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'blocked', by: 'kill_switch' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    // the switch is off: the pass reads nothing and sends nothing
    w.switches.paypal_outbound = false;
    const before = w.paypal.calls.length;
    expect(await pass()).toEqual({ processed: 0, still_unknown: 0, expired: 0, abandoned: 0 });
    expect(w.paypal.calls.length).toBe(before);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    // reset: one pass finishes the pack
    w.switches.paypal_outbound = true;
    await pass();
    const key = `umsK-${a.order_ref}-p2`;
    // one call the kill switch answered (it spent nothing) and one that PayPal executed, same key
    expect(callsOf(poIds(a)[1]!, 'capture').map((c) => c.request_id)).toEqual([key, key]);
    expect(w.paypal.orders.get(poIds(a)[1]!)!.capture_request_id).toBe(key);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await sales()).toBe(2);
    await pass();
    expect(callsOf(poIds(a)[1]!, 'capture')).toHaveLength(2);
  });

  it('lost lease on PO2 capture: one same-key resend', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const base = w.paypal.count('get');
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        w.faults.dieBeforeCapture = true; // the PO2 capture never reaches PayPal
      }
    };
    await expect(ret(a.order_ref)).rejects.toThrow('died before the capture');
    w.faults.dieBeforeCapture = false;
    expect(await states(a.order_id)).toEqual(['captured', 'capture_requested']);
    expect((await capOps(a.order_id)).map((o) => o.state)).toEqual(['confirmed', 'sent']);
    w.tick(61_000); // the lease of the dead call ran out
    await pass();
    const key = `umsK-${a.order_ref}-p2`;
    const seq = w.paypal.calls.filter((c) => c.provider_order_id === poIds(a)[1]);
    // the return's two reads and the capture that died, then read first, the same key once, read back
    expect(seq.map((c) => c.op)).toEqual(['get', 'get', 'capture', 'get', 'capture', 'get']);
    expect(callsOf(poIds(a)[1]!, 'capture').map((c) => c.request_id)).toEqual([key, key]);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect(await sales()).toBe(2);
    expect(await failedInvariants()).toEqual([]);
  });

  it('PO2 GET COMPLETED after a lost capture answer: captured, never declined', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('unresolved');
    // long past the deadline of a PayPal order nobody sent anything for: the read still decides
    w.tick(26 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect(await alerts('partial_composite')).toEqual([]);
    expect(capCalls()).toHaveLength(2);
    expect(await sales()).toBe(2);
  });

  it('PO2 GET VOIDED, no send: declined, paid_partial, partial alert', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.paypal.void(poIds(a)[1]!);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect((await orderRow(a.order_id)).mismatch).toBe(false);
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'declined',
    ]);
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['captured', 'denied']);
    expect(capCalls()).toHaveLength(1); // PO2 was never captured
    expect(await sales()).toBe(1);
    // nothing more happens, nothing more is raised
    const calls = w.paypal.calls.length;
    await pass();
    expect(w.paypal.calls.length).toBe(calls);
    expect(await alerts('partial_composite')).toHaveLength(1);
  });

  it('PO2 VOIDED but a send is unknown: not declined', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const base = w.paypal.count('get');
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        w.faults.dieBeforeCapture = true;
      }
    };
    await expect(ret(a.order_ref)).rejects.toThrow('died before the capture');
    w.faults.dieBeforeCapture = false;
    w.paypal.void(poIds(a)[1]!);
    w.tick(61_000);
    await pass();
    // the send is unknown, so a VOIDED read with no capture proves nothing about money
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    expect((await orderRow(a.order_id)).status).toBe('unresolved');
    expect(await alerts('partial_composite')).toEqual([]);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'expected',
    ]);
    // even at the end of the window: a human is told, the PayPal order is never declared not charged
    w.tick(25 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    expect(await alerts('partial_composite')).toEqual([]);
  });

  it('ORDER_ALREADY_CAPTURED on PO2: read-back decides', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    const po2 = poIds(a)[1]!;
    // PO2 was captured out of band; the continuation's read is stale and still shows APPROVED
    await w.paypal.captureOrder({ provider_order_id: po2, request_id: 'oob-key', scenario: null });
    const snap = await w.paypal.getOrder(po2);
    if (snap.kind !== 'order') throw new Error('no read');
    w.paypal.queue.get.push({
      ...snap,
      status: 'APPROVED',
      units: snap.units.map((u) => ({ ...u, capture: null })),
    });
    await pass();
    const mine = callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'));
    expect(mine).toHaveLength(1);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']); // never declined
    expect(await alerts('partial_composite')).toEqual([]);
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect(await sales()).toBe(2);
    expect(callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'))).toHaveLength(1);
  });

  it('PO2 captured out of band and read as COMPLETED: read-back and match, no capture of ours, one alert', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    const po2 = poIds(a)[1]!;
    await w.paypal.captureOrder({ provider_order_id: po2, request_id: 'oob-key', scenario: null });
    await pass();
    expect(callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'))).toHaveLength(0);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await sales()).toBe(2);
    expect((await alerts('unexpected_capture')).map((x) => x.reason)).toEqual([
      'continuation_capture_found_p2',
    ]);
  });

  it('PO2 captured out of band with another payee: PO2 frozen, nothing unlocked for PO2, never captured again', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    const po2 = poIds(a)[1]!;
    await w.paypal.captureOrder({ provider_order_id: po2, request_id: 'oob-key', scenario: null });
    w.paypal.tamperAfterCapture.set(po2, { payee: 'SBXEVILPAYEE' });
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['available', 'locked']);
    expect(await sales()).toBe(1);
    expect(callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'))).toHaveLength(0);
    expect(await alerts('partial_composite')).toEqual([]);
  });

  it('PO2 APPROVED but another payee on the fresh read: PO2 frozen only, never captured', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(capCalls()).toHaveLength(1);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
    expect(await alerts('partial_composite')).toEqual([]); // frozen is on hold, not "not charged"
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'mismatch',
    ]);
  });

  it('payer_action on PO2 after PO1 captured: approve_url on PO2 only; declined after the deadline on a no-capture read', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const before = await providerOrdersOf(w, a.order_id);
    w.paypal.queue.capture.push('real', {
      kind: 'payer_action',
      redirect_url: AGAIN,
      debug_id: 'D',
    });
    await ret(a.order_ref);
    const after = await providerOrdersOf(w, a.order_id);
    expect(after[0]!.approve_url).toBe(before[0]!.approve_url);
    expect(after[1]!.approve_url).toBe(AGAIN);
    expect(after.map((p) => p.state)).toEqual(['captured', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
    // PayPal no longer shows the approval: the buyer has to act, the pack waits
    w.paypal.orders.get(poIds(a)[1]!)!.status = 'CREATED';
    w.tick(31_000);
    await pass();
    expect(capCalls()).toHaveLength(2);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
    // 24 h later the pack is still not abandoned (a capture was sent) ...
    w.tick(24 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    // ... and past the deadline a read with no capture ends it: PO2 declined, not charged
    w.tick(2 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
    expect(capCalls()).toHaveLength(2);
  });

  it('payer_action on PO2, the buyer approves again: captured with the next key', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', {
      kind: 'payer_action',
      redirect_url: AGAIN,
      debug_id: 'D',
    });
    await ret(a.order_ref);
    w.tick(31_000);
    await pass();
    expect(callsOf(poIds(a)[1]!, 'capture').map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p2`,
      `umsK-${a.order_ref}-p2-2`,
    ]);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
  });

  it('pack payer_action on the due path: only that PayPal order reopens; the order is never awaiting_buyer while PO1 is unresolved', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const before = await providerOrdersOf(w, a.order_id);
    // PO1 is captured but PENDING at PayPal: it stays unresolved and polls
    w.paypal.nextBy.set(poIds(a)[0]!, { status: 'PENDING', fee: null });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(await states(a.order_id)).toEqual(['unresolved', 'approved']);
    // the continuation sends PO2; the answer is lost
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await pass();
    expect(await states(a.order_id)).toEqual(['unresolved', 'unresolved']);
    // the retry of PO2 is answered with payer_action
    w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
    w.tick(31_000);
    await pass();
    const pos = await providerOrdersOf(w, a.order_id);
    expect(pos.map((p) => p.state)).toEqual(['unresolved', 'approved']);
    expect(pos[1]!.approve_url).toBe(AGAIN);
    expect(pos[0]!.approve_url).toBe(before[0]!.approve_url); // PO1's url is not touched
    expect((await orderRow(a.order_id)).status).toBe('unresolved'); // never awaiting_buyer
    expect(callsOf(poIds(a)[1]!, 'capture')).toHaveLength(2); // sent, resent once; no third in this pass
    expect((await capOps(a.order_id)).map((o) => o.state)).toEqual(['confirmed', 'prepared']);
  });

  it('D-014 cap reached: deadline applies', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    for (const key of [`umsK-${a.order_ref}-p2`, `umsK-${a.order_ref}-p2-2`]) {
      w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
      await pass();
      expect(callsOf(poIds(a)[1]!, 'capture').at(-1)!.request_id).toBe(key);
      expect(await states(a.order_id)).toEqual(['captured', 'approved']);
      w.tick(31_000);
    }
    // both keys are spent (1 + max_capture_retries): the next no-capture read ends PO2 at once
    await pass();
    expect(callsOf(poIds(a)[1]!, 'capture')).toHaveLength(2);
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
  });

  it('deadline, PO2 unreadable: one payment_unresolved alert', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.tick(PAST_DEADLINE);
    w.paypal.queue.get.push({ kind: 'timeout' });
    await pass();
    expect(await alerts('payment_unresolved')).toEqual([{ reason: 'deadline_unreadable_p2' }]);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    w.tick(31_000);
    w.paypal.queue.get.push({ kind: 'timeout' });
    await pass();
    expect(await alerts('payment_unresolved')).toHaveLength(1);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    // readable again: no capture on the fresh read past the deadline, so PO2 is declined
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
  });

  it('PO2 APPROVED before the deadline is captured, not declined', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.tick(25 * H - 1_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
  });

  it('PO2 APPROVED after the deadline (case 2b): declined, never captured', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.tick(PAST_DEADLINE);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect(capCalls()).toHaveLength(1);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
  });

  it('continuation counted against the due budget', async () => {
    w = await makeWorld();
    const a1 = await crashBetweenCaptures();
    const a2 = await crashBetweenCaptures({ buyer_id: 'buy_B', actor: BUYER_B });
    const r1 = await runDue(w.deps, { max_items: 1 });
    expect(r1.processed).toBe(1);
    const s1 = [(await orderRow(a1.order_id)).status, (await orderRow(a2.order_id)).status].sort();
    expect(s1).toEqual(['capture_requested', 'paid']);
    const r2 = await runDue(w.deps, { max_items: 1 });
    expect(r2.processed).toBe(1);
    expect((await orderRow(a1.order_id)).status).toBe('paid');
    expect((await orderRow(a2.order_id)).status).toBe('paid');
    expect((await runDue(w.deps, { max_items: 1 })).processed).toBe(0);
    expect(await sales()).toBe(4);
  });

  it('the continuation also runs in a money-only pass: a started pack always finishes', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    const r = await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect(r.processed).toBe(1);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
  });

  it('D-02 PO1 DECLINED at capture, crash before PO2: continuation captures PO2, paid_partial, one partial_composite alert', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[0]!, { status: 'DECLINED', fee: null });
    const base = w.paypal.count('get');
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        throw new Error('process died between the captures');
      }
    };
    await expect(ret(a.order_ref)).rejects.toThrow('died between the captures');
    expect(await states(a.order_id)).toEqual(['declined', 'approved']);
    // a decline after a send still lets the pack finish
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
    await pass();
    expect(await states(a.order_id)).toEqual(['declined', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
    expect(callsOf(poIds(a)[0]!, 'capture')).toHaveLength(1); // a declined PayPal order is not captured again
    expect(await sales()).toBe(1);
  });

  it('pack with nothing sent, PO1 reopened: not picked', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['approved', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('awaiting_buyer'); // nothing was sent
    w.tick(31_000);
    const before = w.paypal.calls.length;
    await pass();
    expect(w.paypal.calls.length).toBe(before);
    expect(await states(a.order_id)).toEqual(['approved', 'approved']);
  });

  it('a frozen PayPal order never reads "not charged": no pass, sweep or deadline moves it', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.tamperAfterCapture.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    w.tick(48 * H);
    await pass();
    w.tick(48 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'mismatch',
    ]);
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['available', 'locked']);
    expect(await alerts('partial_composite')).toEqual([]);
    expect(capCalls()).toHaveLength(2);
  });
});

describe('the pack window, the 24 h sweep and the abandonment on the due pass', () => {
  it('24 h sweep, nothing sent, PO2 unapproved: abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1); // approved at PayPal, but nobody returned
    w.tick(24 * H + 1);
    const r = await pass();
    expect(r.abandoned).toBe(1);
    expect(callsOf(poIds(a)[0]!, 'get').length).toBeGreaterThanOrEqual(1);
    expect(callsOf(poIds(a)[1]!, 'get').length).toBeGreaterThanOrEqual(1); // every PayPal order is read
    expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect((await orderRow(a.order_id)).status).toBe('abandoned');
    expect(capCalls()).toHaveLength(0);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual(['declined', 'declined']);
    expect(await alerts('partial_composite')).toEqual([]);
  });

  it('24 h sweep, both APPROVED and nobody returned: captured once (P17)', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    approvePo(w, a, 2);
    w.tick(24 * H + 1);
    await pass();
    expect(capCalls().map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p1`,
      `umsK-${a.order_ref}-p2`,
    ]);
    expect((await orderRow(a.order_id)).status).toBe('paid');
  });

  it('window run out, both APPROVED: captured once (P17)', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref); // PO1 approved, first_approved_at set; PO2 still awaiting the buyer
    approvePo(w, a, 2);
    w.tick(59 * 60_000);
    const before = w.paypal.calls.length;
    await pass();
    expect(w.paypal.calls.length).toBe(before); // the window has not run out: nothing is read
    w.tick(2 * 60_000);
    await pass();
    expect(capCalls().map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p1`,
      `umsK-${a.order_ref}-p2`,
    ]);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
  });

  it('window run out on the due pass, no return: abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['approved', 'awaiting_buyer']);
    w.tick(H + 1);
    const r = await pass();
    expect(r.abandoned).toBe(1);
    expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect((await orderRow(a.order_id)).status).toBe('abandoned');
    expect(capCalls()).toHaveLength(0);
    expect(await alerts('partial_composite')).toEqual([]);
    expect(await sales()).toBe(0);
  });

  it('an approval that disappears after the window is abandoned by the next due pass, without a second return', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    approvePo(w, a, 2);
    // PO1's capture needs the payer again: both PayPal orders are approved, nothing was sent
    w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['approved', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('awaiting_buyer');
    w.paypal.orders.get(poIds(a)[0]!)!.status = 'CREATED';
    w.tick(H + 1);
    await pass();
    expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect(capCalls()).toHaveLength(1);
  });

  it('a pack is never abandoned while capture_sent holds, however old', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.paypal.orders.get(poIds(a)[1]!)!.status = 'CREATED'; // never approved again
    w.tick(24 * H + 1);
    const r = await pass();
    expect(r.abandoned).toBe(0);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
  });

  it('a capture found on a pack nobody captured is never abandoned: taken over, alerted, read decides', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    approvePo(w, a, 2);
    await w.paypal.captureOrder({
      provider_order_id: poIds(a)[0]!,
      request_id: 'oob-key',
      scenario: null,
    });
    w.tick(24 * H + 1);
    const r = await pass();
    expect(r.abandoned).toBe(0);
    expect((await alerts('unexpected_capture')).map((x) => x.reason)).toContain('abandon_sweep_p1');
    expect((await states(a.order_id))[0]).toBe('captured');
    expect(await sales()).toBe(1);
    // the pack has a capture now, so it can only finish: PO2 (approved at PayPal) is captured by the continuation
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect(await sales()).toBe(2);
  });

  it('nextDueAt wakes for the continuation, and for the pack window', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    const next = await nextDueAt(w.db, w.deps.config);
    const created = (
      await w.rows<{ created_at: Date }>('SELECT created_at FROM orders WHERE id = $1', [
        a.order_id,
      ])
    )[0]!.created_at.getTime();
    // the pack window ends long before the 24 h abandonment time
    expect(Date.parse(next!)).toBeLessThan(created + 24 * H);
    expect(Date.parse(next!)).toBeLessThanOrEqual(w.clock.now().getTime() + H);
    await w.close();

    w = await makeWorld();
    const b = await crashBetweenCaptures();
    const due = await nextDueAt(w.db, w.deps.config);
    expect(Date.parse(due!)).toBeLessThanOrEqual(w.clock.now().getTime());
    await pass();
    expect(await states(b.order_id)).toEqual(['captured', 'captured']);
  });
});

describe('create and expiry per PayPal order', () => {
  async function pack2CreateLost() {
    w = await makeWorld();
    const p = await place(w, PACK);
    w.paypal.queue.create.push('real', { kind: 'timeout' });
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c).toEqual({ ok: false, error: { code: 'create_failed' } });
    expect(await states(p.order_id)).toEqual(['awaiting_buyer', 'prepared']);
    expect((await orderRow(p.order_id)).status).toBe('created');
    return p;
  }

  it('lost PO2 create resent with a single-unit body (one unit, own invoice_id, own key)', async () => {
    const p = await pack2CreateLost();
    const po1 = (await providerOrdersOf(w, p.order_id))[0]!;
    w.tick(31_000);
    await pass();
    const creates = w.paypal.calls.filter((c) => c.op === 'create');
    expect(creates.map((c) => c.request_id)).toEqual([
      `umsC-${p.order_ref}-p1`,
      `umsC-${p.order_ref}-p2`,
      `umsC-${p.order_ref}-p2`,
    ]);
    const orders = [...w.paypal.orders.values()];
    expect(orders).toHaveLength(2);
    for (const o of orders) expect(o.req.units).toHaveLength(1);
    const second = orders.find((o) => o.req.request_id === `umsC-${p.order_ref}-p2`)!;
    expect(second.req.invoice_id).toBe(`${p.order_ref}-p2`);
    expect(second.req.units[0]!.payee_merchant_id).toBe('MERCH2');
    // only PO2 was written; PO1 is untouched
    const pos = await providerOrdersOf(w, p.order_id);
    expect(pos.map((x) => x.state)).toEqual(['awaiting_buyer', 'awaiting_buyer']);
    expect(pos[0]!.provider_order_id).toBe(po1.provider_order_id);
    expect(pos[0]!.approve_url).toBe(po1.approve_url);
    expect(pos[1]!.provider_order_id).toBe(second.id);
    expect((await orderRow(p.order_id)).status).toBe('awaiting_buyer');
    // the buyer's next checkout answers step 1 of 2
    const again = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(again.ok && again.value.progress).toEqual({ step: 1, of: 2 });
    expect(w.paypal.count('create')).toBe(3);
  });

  it('a resent PO2 create refused: the whole order fails, nothing captured', async () => {
    const p = await pack2CreateLost();
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'PAYEE_ACCOUNT_RESTRICTED',
      debug_id: 'D',
    });
    w.tick(31_000);
    await pass();
    expect(await states(p.order_id)).toEqual(['failed', 'failed']);
    expect((await orderRow(p.order_id)).status).toBe('failed');
    expect((await unitRows(p.order_id)).map((u) => u.status)).toEqual(['declined', 'declined']);
  });

  it('a resent PO2 create answered DUPLICATE_INVOICE_ID: the whole order is frozen', async () => {
    const p = await pack2CreateLost();
    w.paypal.queue.create.push({
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    w.tick(31_000);
    await pass();
    expect(await states(p.order_id)).toEqual(['frozen', 'frozen']);
    expect(await orderRow(p.order_id)).toMatchObject({ status: 'frozen', mismatch: true });
  });

  it('expireCreate with a PayPal order that never got an id: whole order failed', async () => {
    const p = await pack2CreateLost();
    w.tick(5 * H + 1_000); // the 5 h key window of the create has ended
    await pass();
    expect(w.paypal.count('create')).toBe(2); // nothing was resent
    expect(await states(p.order_id)).toEqual(['failed', 'failed']);
    expect((await orderRow(p.order_id)).status).toBe('failed');
    expect((await unitRows(p.order_id)).map((u) => u.status_reason)).toEqual([
      'create_unresolved',
      'create_unresolved',
    ]);
    expect((await alerts('payment_unresolved')).map((x) => x.reason)).toEqual([
      'create_window_expired',
    ]);
  });
});

describe('the late and the stale answers of the capture retry', () => {
  it('late DUPLICATE_INVOICE_ID on a dead operation: no change', async () => {
    w = await makeWorld();
    const a = await lostResponse(w);
    const order = (await loadOrder(w.db, a.order_id))!;
    const op = (await loadOperation(w.db, a.order_id, 'capture'))!;
    // While the resend is open a read shows the first capture: verified, paid. Then the late answer comes.
    w.paypal.captureOrder = async () => {
      await reapply(w, a.order_id);
      return DUPLICATE;
    };
    const res = await retryCapture(w.deps, order, op, a.provider_order_id);
    expect(res).not.toBe('frozen');
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid', mismatch: false });
    expect(await states(a.order_id)).toEqual(['captured']);
    expect(await alerts('frozen_order')).toEqual([]);
    expect((await loadOperation(w.db, a.order_id, 'capture'))!.state).toBe('confirmed');
  });

  it('DUPLICATE_INVOICE_ID on the retry of PO1 before any capture: the whole order is frozen', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['unresolved', 'approved']);
    w.paypal.queue.capture.push(DUPLICATE);
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['frozen', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'frozen', mismatch: true });
    expect((await alerts('frozen_order')).map((x) => x.reason)).toEqual([
      'duplicate_invoice_id_p1',
    ]);
    expect(capCalls()).toHaveLength(2); // PO2 was never captured
  });

  it('DUPLICATE_INVOICE_ID on the retry of PO2 after PO1 captured: PO2 frozen only', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'timeout' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    w.paypal.queue.capture.push(DUPLICATE);
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
    expect((await alerts('frozen_order')).map((x) => x.reason)).toEqual([
      'duplicate_invoice_id_p2',
    ]);
    expect(await alerts('partial_composite')).toEqual([]);
    expect(await sales()).toBe(1);
  });

  it('single payer_action: awaiting_buyer, unchanged', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await ret(a.order_ref);
    expect((await orderRow(a.order_id)).status).toBe('unresolved');
    w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
    w.tick(31_000);
    await pass();
    expect((await orderRow(a.order_id)).status).toBe('awaiting_buyer');
    expect(await states(a.order_id)).toEqual(['approved']);
    expect((await providerOrdersOf(w, a.order_id))[0]!.approve_url).toBe(AGAIN);
    expect((await capOps(a.order_id)).map((o) => o.state)).toEqual(['prepared']);
  });
});

describe('every PayPal order is read by its own stored id', () => {
  it('a poll reads every PayPal order and applies each read to its own slice', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[0]!, { lose_response: true });
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    await ret(a.order_ref); // PO1 unresolved; PO2 not captured by the return
    await pass(); // the continuation captures PO2; its answer is lost too
    expect(await states(a.order_id)).toEqual(['unresolved', 'unresolved']);
    const before = w.paypal.calls.length;
    const report = await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'manual' });
    expect(w.paypal.calls.slice(before).map((c) => [c.op, c.provider_order_id])).toEqual([
      ['get', poIds(a)[0]],
      ['get', poIds(a)[1]],
    ]);
    expect('order_status' in report && report.order_status).toBe('paid');
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await sales()).toBe(2);
  });

  it('the paid re-read reads a declined PayPal order too: a late capture there raises unexpected_capture and unlocks nothing', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.paypal.void(poIds(a)[1]!);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    // PayPal captures it after all (the order comes back to life)
    const o = w.paypal.orders.get(poIds(a)[1]!)!;
    o.status = 'APPROVED';
    await w.paypal.captureOrder({
      provider_order_id: poIds(a)[1]!,
      request_id: 'late-key',
      scenario: null,
    });
    w.tick(H + 1_000);
    await pass();
    expect((await alerts('unexpected_capture')).map((x) => x.reason)).toEqual(['status_declined']);
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect(await sales()).toBe(1);
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['captured', 'denied']);
  });

  it('a unit we declined whose capture later shows COMPLETED raises unexpected_capture declined_unit_received and unlocks nothing', async () => {
    w = await makeWorld();
    const a = await lostResponse(w); // single order: captured at PayPal, answer lost, unresolved
    const unit = (await unitRows(a.order_id))[0]!;
    expect(unit.status).not.toBe('captured_verified');
    // we had declined the unit (e.g. a refused capture); PayPal's read now shows the capture
    await w.rows(
      "UPDATE order_units SET status = 'declined', status_reason = 'capture_refused' WHERE order_id = $1",
      [a.order_id],
    );
    await w.rows(
      "UPDATE entitlements SET money_state = 'denied' WHERE unit_id IN (SELECT id FROM order_units WHERE order_id = $1)",
      [a.order_id],
    );
    const report = await reapply(w, a.order_id);
    expect(report.unlocked).toEqual([]);
    expect(await alerts('unexpected_capture')).toEqual([{ reason: 'declined_unit_received' }]);
    const after = (
      await w.rows<{ captured_verified_at: unknown; status: string }>(
        'SELECT captured_verified_at, status FROM order_units WHERE order_id = $1',
        [a.order_id],
      )
    )[0]!;
    expect(after.captured_verified_at).toBeNull();
    expect(after.status).toBe('declined');
    expect(await sales()).toBe(0);
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['locked']);
  });
});
