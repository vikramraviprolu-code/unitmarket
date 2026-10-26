// DP-2b (MVP-D, route D2): the background paths per PayPal order and the continuation after the first
// capture. Real PGlite, scripted PayPal. A pack is the approval of ofr_1 (publisher 1) and ofr_3
// (publisher 2): two units, two PayPal orders, one capture each. The rules under test are in
// docs/specs/mvp-d-dp2b-reconcile-continuation.md and docs/specs/mvp-d-overview.md section 3.
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureRes, Logger, PaymentsDeps } from '@umsbx/contracts';
import {
  beginCheckout,
  checkInvariants,
  nextDueAt,
  onBuyerReturn,
  reconcileOrder,
  runDue,
} from './index';
import { markUnknown } from './due';
import { resendCreate, retryCapture } from './reconcile';
import { loadOperation, loadOrder } from './store';
import { reapply, sha256ForArticle } from './support';
import {
  BUYER_A,
  BUYER_B,
  approvePo,
  approved,
  awaiting,
  count,
  deadCapture,
  lostResponse,
  makeWorld,
  sentCapture,
  place,
  providerOrdersOf,
} from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';

let w: OpsWorld;

/** A world whose log records every error event: a swallowed failure in a pass must fail the test, not hide in it. */
const logged: string[] = [];
async function world(): Promise<OpsWorld> {
  const x = await makeWorld();
  const log: Logger = {
    log: (e) => {
      if (e.level === 'error') logged.push(`${e.msg} ${JSON.stringify(e.fields)}`);
    },
    child: () => log,
  };
  x.deps = { ...x.deps, log };
  return x;
}
afterEach(async () => {
  expect(logged.splice(0)).toEqual([]);
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    // the window end touches the items of PO2 only: they become unknown, PO1's stay captured
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['captured', 'unknown']);
    expect((await alerts('payment_unresolved')).map((x) => x.reason)).toEqual([
      'window_expired_p2',
    ]);
  });

  it('ORDER_ALREADY_CAPTURED on PO2: read-back decides', async () => {
    w = await world();
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
    expect(callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'))).toHaveLength(
      1,
    );
  });

  it('PO2 captured out of band and read as COMPLETED: read-back and match, no capture of ours, one alert', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    const po2 = poIds(a)[1]!;
    await w.paypal.captureOrder({ provider_order_id: po2, request_id: 'oob-key', scenario: null });
    await pass();
    expect(callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'))).toHaveLength(
      0,
    );
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await sales()).toBe(2);
    expect((await alerts('unexpected_capture')).map((x) => x.reason)).toEqual([
      'continuation_capture_found_p2',
    ]);
  });

  it('PO2 captured out of band with another payee: PO2 frozen, nothing unlocked for PO2, never captured again', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    const po2 = poIds(a)[1]!;
    await w.paypal.captureOrder({ provider_order_id: po2, request_id: 'oob-key', scenario: null });
    w.paypal.tamperAfterCapture.set(po2, { payee: 'SBXEVILPAYEE' });
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['available', 'locked']);
    expect(await sales()).toBe(1);
    expect(callsOf(po2, 'capture').filter((c) => c.request_id?.startsWith('umsK-'))).toHaveLength(
      0,
    );
    expect(await alerts('partial_composite')).toEqual([]);
  });

  it('PO2 APPROVED but another payee on the fresh read: PO2 frozen only, never captured', async () => {
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
    const a = await crashBetweenCaptures();
    // a PayPal order that was reopened is polled on the backoff schedule counted from the first send:
    // 30 s after it for the second try, 3 minutes after the second reopen for the third look
    for (const [key, wait] of [
      [`umsK-${a.order_ref}-p2`, 31_000],
      [`umsK-${a.order_ref}-p2-2`, 180_000],
    ] as const) {
      w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
      await pass();
      expect(callsOf(poIds(a)[1]!, 'capture').at(-1)!.request_id).toBe(key);
      expect(await states(a.order_id)).toEqual(['captured', 'approved']);
      w.tick(wait);
    }
    // both keys are spent (1 + max_capture_retries): the next no-capture read ends PO2 at once
    await pass();
    expect(callsOf(poIds(a)[1]!, 'capture')).toHaveLength(2);
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
  });

  it('deadline, PO2 unreadable: one payment_unresolved alert', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    w.tick(PAST_DEADLINE);
    w.paypal.queue.get.push({ kind: 'timeout' });
    await pass();
    expect(await alerts('payment_unresolved')).toEqual([{ reason: 'deadline_unreadable_p2' }]);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    w.tick(H + 1_000); // an hour is the poll rate by now
    w.paypal.queue.get.push({ kind: 'timeout' });
    await pass();
    expect(await alerts('payment_unresolved')).toHaveLength(1);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    // readable again: no capture on the fresh read past the deadline, so PO2 is declined
    w.tick(H + 1_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
  });

  it('a PayPal order that waits for the buyer is read about once an hour, not on every pass (call budget)', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    const po2 = poIds(a)[1]!;
    w.paypal.orders.get(po2)!.status = 'CREATED'; // the buyer has not approved again
    const before = callsOf(po2, 'get').length;
    for (let minute = 5; minute <= 6 * 60; minute += 5) {
      w.tick(5 * 60_000);
      await pass();
    }
    const reads = callsOf(po2, 'get').length - before;
    expect(reads).toBeGreaterThanOrEqual(5);
    expect(reads).toBeLessThanOrEqual(10); // 72 passes in 6 h, a handful of reads
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
  });

  it('PO2 APPROVED before the deadline is captured, not declined', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    w.tick(25 * H - 1_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
  });

  it('PO2 APPROVED after the deadline (case 2b): declined, never captured', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    w.tick(PAST_DEADLINE);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect(capCalls()).toHaveLength(1);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
  });

  it('continuation counted against the due budget', async () => {
    w = await world();
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
    w = await world();
    const a = await crashBetweenCaptures();
    const r = await runDue(w.deps, { max_items: 10, allow: 'money_only' });
    expect(r.processed).toBe(1);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
  });

  it('D-02 PO1 DECLINED at capture, crash before PO2: continuation captures PO2, paid_partial, one partial_composite alert', async () => {
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
    const a = await crashBetweenCaptures();
    w.paypal.orders.get(poIds(a)[1]!)!.status = 'CREATED'; // never approved again
    w.tick(24 * H + 1);
    const r = await pass();
    expect(r.abandoned).toBe(0);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
  });

  it('a capture found on a pack nobody captured is never abandoned: taken over, alerted, read decides', async () => {
    w = await world();
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
    w = await world();
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

    w = await world();
    const b = await crashBetweenCaptures();
    const due = await nextDueAt(w.db, w.deps.config);
    expect(Date.parse(due!)).toBeLessThanOrEqual(w.clock.now().getTime());
    await pass();
    expect(await states(b.order_id)).toEqual(['captured', 'captured']);
  });
});

describe('create and expiry per PayPal order', () => {
  async function pack2CreateLost() {
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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
    w = await world();
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

describe('boundaries pinned by the mutation run (DP-2b)', () => {
  it('markUnknown on a capture operation with no PayPal order reference (an older row) moves the only PayPal order', async () => {
    w = await world();
    const a = await sentCapture(w);
    await w.rows(
      "UPDATE operations SET provider_order_ref = NULL WHERE order_id = $1 AND kind = 'capture'",
      [a.order_id],
    );
    const op = (await loadOperation(w.db, a.order_id, 'capture'))!;
    expect(op.provider_order_ref ?? null).toBeNull();
    expect(await states(a.order_id)).toEqual(['capture_requested']);
    await w.db.transaction((tx) =>
      markUnknown(
        tx,
        w.deps,
        {
          id: op.id,
          order_id: a.order_id,
          kind: 'capture',
          first_sent_at: op.first_sent_at,
          request_id: op.request_id,
        },
        'sent',
      ),
    );
    expect(await states(a.order_id)).toEqual(['unresolved']);
    expect((await orderRow(a.order_id)).status).toBe('unresolved');
  });

  it('the end of the window with a failed read of a captured PayPal order raises nothing and closes its operation', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    // PO1's read-back is open again and its window has ended; the read fails
    await w.rows(
      `UPDATE operations SET state = 'unknown', next_retry_at = $2, reconcile_until = $3
        WHERE order_id = $1 AND kind = 'readback'
          AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 1)`,
      [
        a.order_id,
        w.clock.now().toISOString(),
        new Date(w.clock.now().getTime() - 1_000).toISOString(),
      ],
    );
    w.paypal.queue.get.push({ kind: 'timeout' });
    await pass();
    expect(await alerts('payment_unresolved')).toEqual([]);
    expect(
      (
        await w.rows<{ state: string; failure_reason: string | null }>(
          `SELECT o.state, o.failure_reason FROM operations o JOIN provider_orders p ON p.id = o.provider_order_ref
            WHERE o.order_id = $1 AND o.kind = 'readback' AND p.position = 1`,
          [a.order_id],
        )
      )[0],
    ).toEqual({ state: 'failed', failure_reason: 'window_expired' });
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
  });

  it('24 h sweep: a PayPal order that is gone abandons a pack, but a single order is read again later', async () => {
    w = await world();
    const pack = await awaiting(w, PACK);
    approvePo(w, pack, 1);
    w.paypal.orders.delete(poIds(pack)[1]!); // PO2 is gone at PayPal
    const single = await awaiting(w, { buyer_id: 'buy_B', actor: BUYER_B, offers: ['ofr_2'] });
    w.paypal.orders.delete(single.provider_order_id);
    w.tick(24 * H + 1);
    const r = await pass();
    expect(await states(pack.order_id)).toEqual(['abandoned', 'abandoned']);
    expect((await orderRow(pack.order_id)).status).toBe('abandoned');
    // the single order keeps its older rule: an answer that is not an order is skipped, not abandoned
    expect((await orderRow(single.order_id)).status).toBe('awaiting_buyer');
    expect(r.abandoned).toBe(1);
  });

  it('a candidate that is skipped (the read is blocked) does not use up the budget of the pass', async () => {
    w = await world();
    const a1 = await crashBetweenCaptures();
    const a2 = await crashBetweenCaptures({ buyer_id: 'buy_B', actor: BUYER_B });
    w.paypal.queue.get.push({ kind: 'blocked', by: 'kill_switch' });
    const r = await runDue(w.deps, { max_items: 1 });
    expect(r.processed).toBe(1);
    const statuses = [(await orderRow(a1.order_id)).status, (await orderRow(a2.order_id)).status];
    expect(statuses.sort()).toEqual(['capture_requested', 'paid']);
  });

  it('a pack taken over by a capture found at the sweep: the deadline of a PayPal order nobody approved counts from the send', async () => {
    w = await world();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await w.paypal.captureOrder({
      provider_order_id: poIds(a)[0]!,
      request_id: 'oob-key',
      scenario: null,
    });
    w.tick(24 * H + 1);
    await pass(); // taken over: PO1 captured; PO2 never approved (first_approved_at is empty)
    expect(await states(a.order_id)).toEqual(['captured', 'awaiting_buyer']);
    const sentAt = w.clock.now().getTime();
    w.tick(24 * H); // the window and the reconcile window (25 h) have not passed since the send
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'awaiting_buyer']);
    w.tick(2 * H);
    expect(w.clock.now().getTime() - sentAt).toBeGreaterThan(25 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
  });

  it.each([
    [3, 'umsK-%-p2-2', 'captured'],
    [4, null, 'declined'],
  ] as const)(
    'the attempt cap: a reopened PayPal order with %i attempts used %s',
    async (attempts, key, final) => {
      w = await world();
      const a = await crashBetweenCaptures();
      w.paypal.queue.capture.push({ kind: 'payer_action', redirect_url: AGAIN, debug_id: 'D' });
      await pass(); // the first try: payer_action, PO2 is reopened (prepared, send timestamp)
      expect(await states(a.order_id)).toEqual(['captured', 'approved']);
      await w.rows(
        `UPDATE operations SET attempt = $2 WHERE order_id = $1 AND kind = 'capture'
            AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 2)`,
        [a.order_id, attempts],
      );
      w.tick(180_000);
      await pass();
      const sent = callsOf(poIds(a)[1]!, 'capture').map((c) => c.request_id);
      if (key === null) {
        // one attempt more than 2 x (1 + max_capture_retries) would be made: nothing is sent, the PayPal order ends
        expect(sent).toHaveLength(1);
      } else {
        expect(sent.at(-1)).toBe(key.replace('%', a.order_ref));
      }
      expect((await states(a.order_id))[1]).toBe(final);
    },
  );

  it('a capture that shows on a PayPal order we had reopened raises no alert: we sent it', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', {
      kind: 'payer_action',
      redirect_url: AGAIN,
      debug_id: 'D',
    });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    // PayPal captured it after all (the buyer approved again and a capture of ours was in flight elsewhere)
    await w.paypal.captureOrder({
      provider_order_id: poIds(a)[1]!,
      request_id: 'late-key',
      scenario: null,
    });
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await alerts('unexpected_capture')).toEqual([]);
    // its prepared capture operation has nothing left to send
    expect((await capOps(a.order_id)).map((o) => o.state)).toEqual(['confirmed', 'confirmed']);
  });
});

describe('reconcile.ts boundaries pinned by the mutation run (DP-2b)', () => {
  it('a capture operation with no PayPal order reference finds its PayPal order by the id given, else the only one', async () => {
    w = await world();
    const single = await lostResponse(w);
    await w.rows(
      "UPDATE operations SET provider_order_ref = NULL WHERE order_id = $1 AND kind = 'capture'",
      [single.order_id],
    );
    const order = (await loadOrder(w.db, single.order_id))!;
    const op = (await loadOperation(w.db, single.order_id, 'capture'))!;
    // a single order: whatever id is given, its only PayPal order is meant
    const sentBefore = capCalls().length;
    expect(['claim', 'unknown']).toContain(await retryCapture(w.deps, order, op, 'SBXNOSUCHORDER'));
    expect(capCalls().length).toBe(sentBefore + 1);
    await w.close();

    w = await world();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'timeout' });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    await w.rows(
      "UPDATE operations SET provider_order_ref = NULL WHERE order_id = $1 AND kind = 'capture'",
      [a.order_id],
    );
    const packOrder = (await loadOrder(w.db, a.order_id))!;
    const packOp = (
      await w.rows<{ id: string }>(
        "SELECT id FROM operations WHERE order_id = $1 AND kind = 'capture' AND state = 'unknown'",
        [a.order_id],
      )
    )[0]!;
    const row = (await loadOperation(w.db, a.order_id, 'capture'))!;
    const unknownOp = { ...row, id: packOp.id, state: 'unknown' as const };
    // an id that names no PayPal order of the pack: the operation belongs to none, nothing is sent
    await expect(retryCapture(w.deps, packOrder, unknownOp, 'SBXNOSUCHORDER')).rejects.toThrow(
      'belongs to no provider order',
    );
    // the id of PO1 (captured) names PO1: it is not in flight, so nothing is sent
    expect(await retryCapture(w.deps, packOrder, unknownOp, poIds(a)[0]!)).toBe('lost');
    // the id of PO2 names PO2: the same key is sent once
    const before = capCalls().length;
    const res = await retryCapture(w.deps, packOrder, unknownOp, poIds(a)[1]!);
    expect(['claim', 'unknown']).toContain(res);
    expect(capCalls().length).toBe(before + 1);
    expect(capCalls().at(-1)!.provider_order_id).toBe(poIds(a)[1]);
  });

  it('DUPLICATE_INVOICE_ID on the retry of PO2 while PO1 is still unresolved: PO2 is held, PO1 is not touched', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push({ kind: 'timeout' }); // PO1: answer lost
    await ret(a.order_ref);
    w.paypal.queue.capture.push({ kind: 'timeout' }); // PO2 sent by the continuation: answer lost
    await pass();
    expect(await states(a.order_id)).toEqual(['unresolved', 'unresolved']);
    // PO1 is not due yet; PO2's retry is answered with a duplicate invoice id
    await w.rows(
      `UPDATE operations SET next_retry_at = $2 WHERE order_id = $1 AND kind = 'capture'
          AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 1)`,
      [a.order_id, new Date(w.clock.now().getTime() + 5 * H).toISOString()],
    );
    w.paypal.queue.capture.push(DUPLICATE);
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['unresolved', 'frozen']);
    expect((await alerts('frozen_order')).map((x) => x.reason)).toEqual([
      'duplicate_invoice_id_p2',
    ]);
  });

  it('a create resend for a PayPal order that has moved on is not sent', async () => {
    const p = await (async () => {
      w = await world();
      const placed = await place(w, PACK);
      w.paypal.queue.create.push('real', { kind: 'timeout' });
      await beginCheckout(w.deps, { order_id: placed.order_id, actor: BUYER_A });
      return placed;
    })();
    const order = (await loadOrder(w.db, p.order_id))!;
    const op = (
      await w.rows<{ id: string }>(
        "SELECT id FROM operations WHERE order_id = $1 AND kind = 'create' AND state = 'unknown'",
        [p.order_id],
      )
    )[0]!;
    const row = (await loadOperation(w.db, p.order_id, 'create'))!;
    const creates = w.paypal.count('create');
    // PO2 has moved on (a human or a sweep); the operation is still unknown
    await w.rows(
      "UPDATE provider_orders SET state = 'abandoned' WHERE order_id = $1 AND position = 2",
      [p.order_id],
    );
    const unknownOp = { ...row, id: op.id, state: 'unknown' as const };
    // attempt must match the stored one for the claim; the guard has to refuse before it
    const stored = (
      await w.rows<{ attempt: number; request_id: string }>(
        'SELECT attempt, request_id FROM operations WHERE id = $1',
        [op.id],
      )
    )[0]!;
    expect(await resendCreate(w.deps, order, { ...unknownOp, ...stored })).toBe('lost');
    expect(w.paypal.count('create')).toBe(creates);
  });
});

describe('more boundaries pinned by the mutation run (DP-2b)', () => {
  it('operations with no PayPal order reference (older rows) are processed: a dead capture is read and sent again, a lost create is resent', async () => {
    w = await world();
    const a = await deadCapture(w);
    await w.rows('UPDATE operations SET provider_order_ref = NULL WHERE order_id = $1', [
      a.order_id,
    ]);
    w.tick(61_000);
    await pass();
    expect(capCalls().map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}`,
      `umsK-${a.order_ref}`,
    ]);
    expect((await orderRow(a.order_id)).status).toBe('paid');

    const b = await place(w, { buyer_id: 'buy_B', actor: BUYER_B, offers: ['ofr_2'] });
    w.paypal.queue.create.push({ kind: 'timeout' });
    await beginCheckout(w.deps, { order_id: b.order_id, actor: BUYER_B });
    await w.rows('UPDATE operations SET provider_order_ref = NULL WHERE order_id = $1', [
      b.order_id,
    ]);
    w.tick(31_000);
    await pass();
    expect(await states(b.order_id)).toEqual(['awaiting_buyer']);
    expect((await orderRow(b.order_id)).status).toBe('awaiting_buyer');
  });

  it('the operations of a PayPal order that is over without money stop without a read, the pack goes on', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[1]!, { status: 'DECLINED', fee: null });
    await ret(a.order_ref);
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    await w.rows(
      `UPDATE operations SET state = 'unknown', next_retry_at = $2, reconcile_until = $3
        WHERE order_id = $1 AND kind = 'readback'
          AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 2)`,
      [
        a.order_id,
        w.clock.now().toISOString(),
        new Date(w.clock.now().getTime() + H).toISOString(),
      ],
    );
    const gets = callsOf(poIds(a)[1]!, 'get').length;
    await pass();
    expect(callsOf(poIds(a)[1]!, 'get')).toHaveLength(gets);
    expect(
      await w.rows(
        `SELECT o.state, o.failure_reason FROM operations o JOIN provider_orders p ON p.id = o.provider_order_ref
          WHERE o.order_id = $1 AND o.kind = 'readback' AND p.position = 2`,
        [a.order_id],
      ),
    ).toEqual([{ state: 'failed', failure_reason: 'declined' }]);
  });

  it('the end of the window of one PayPal order turns the items of that PayPal order unknown and no other', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[0]!, { status: 'PENDING', fee: null });
    await ret(a.order_ref); // PO1: captured but PENDING, unresolved
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await pass(); // the continuation sends PO2; its answer is lost
    expect(await states(a.order_id)).toEqual(['unresolved', 'unresolved']);
    // PO1 is polled much later; PO2's window ends now
    await w.rows(
      `UPDATE operations SET next_retry_at = $2, reconcile_until = $2
        WHERE order_id = $1 AND state = 'unknown'
          AND provider_order_ref = (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 1)`,
      [a.order_id, new Date(w.clock.now().getTime() + 100 * H).toISOString()],
    );
    w.tick(25 * H);
    await pass();
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['pending', 'unknown']);
    expect((await alerts('payment_unresolved')).map((x) => x.reason)).toEqual([
      'window_expired_p2',
    ]);
  });

  it('the deadline of a PayPal order nobody approved counts from the first approval of the pack', async () => {
    w = await world();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref); // PO1 approved: the first approval of the pack
    w.tick(30 * 60_000);
    await w.paypal.captureOrder({
      provider_order_id: poIds(a)[0]!,
      request_id: 'oob-key',
      scenario: null,
    });
    w.tick(31 * 60_000);
    await pass(); // the window has run out: the capture found is taken over
    expect(await states(a.order_id)).toEqual(['captured', 'awaiting_buyer']);
    w.tick(24 * H); // 25 h and a minute after the first approval, 24 h after the take-over
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
  });

  it('a PayPal order that moved on between the list and the pick is left alone, with no read', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    const gets = callsOf(poIds(a)[1]!, 'get').length;
    let moved = false;
    const d2: PaymentsDeps = {
      ...w.deps,
      db: {
        ...w.deps.db,
        query: async (sql: string, params?: unknown[]) => {
          const r = await w.deps.db.query(sql, params);
          if (!moved && sql.includes('sib.sent_at')) {
            moved = true;
            await w.rows(
              "UPDATE provider_orders SET state = 'declined' WHERE order_id = $1 AND position = 2",
              [a.order_id],
            );
          }
          return r;
        },
      } as PaymentsDeps['db'],
    };
    const r = await runDue(d2, { max_items: 10 });
    expect(moved).toBe(true);
    expect(r.processed).toBe(0);
    expect(callsOf(poIds(a)[1]!, 'get')).toHaveLength(gets);
  });

  it('an item that cannot be delivered is never charged by the continuation; once it can, the pack finishes', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    const head = w.content.heads.get('key-art_3')!;
    w.content.heads.delete('key-art_3'); // the content of PO2's article is gone
    await pass();
    expect(capCalls()).toHaveLength(1);
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    w.content.heads.set('key-art_3', { ...head, sha256: sha256ForArticle('art_3') });
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(capCalls()).toHaveLength(2);
  });

  it('the read-back after the continuation capture is not an order: PO2 is unresolved with its read-back operation, the next pass settles it', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    w.paypal.queue.get.push('real', { kind: 'timeout' }); // the fresh read is real, the read-back is lost
    await pass();
    expect(callsOf(poIds(a)[1]!, 'capture')).toHaveLength(1);
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    expect(
      (
        await w.rows<{ request_id: string; state: string }>(
          `SELECT o.request_id, o.state FROM operations o JOIN provider_orders p ON p.id = o.provider_order_ref
            WHERE o.order_id = $1 AND o.kind = 'readback' AND p.position = 2`,
          [a.order_id],
        )
      )[0],
    ).toEqual({ request_id: `umsB-${a.order_ref}-p2`, state: 'unknown' });
    expect(await sales()).toBe(1); // a claim alone books nothing
    w.tick(31_000);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await sales()).toBe(2);
    expect(callsOf(poIds(a)[1]!, 'capture')).toHaveLength(1);
  });

  it('a PayPal order held by the continuation says which unit: a unit mismatch names the unit, an order-level one none', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    await pass();
    const unit2 = (
      await w.rows<{ id: string }>(
        "SELECT id FROM order_units WHERE order_id = $1 AND publisher_id = 'pub_2'",
        [a.order_id],
      )
    )[0]!.id;
    expect(
      await w.rows<{ unit_id: string | null; reason: string }>(
        "SELECT unit_id, detail ->> 'reason' AS reason FROM alerts WHERE kind = 'frozen_order' AND order_id = $1",
        [a.order_id],
      ),
    ).toEqual([{ unit_id: unit2, reason: 'precapture_unit_payee' }]);

    const b = await crashBetweenCaptures({ buyer_id: 'buy_B', actor: BUYER_B });
    w.paypal.tamperBy.set(poIds(b)[1]!, { custom_id: 'SOMEOTHERREF' });
    await pass();
    expect(
      await w.rows<{ unit_id: string | null; reason: string }>(
        "SELECT unit_id, detail ->> 'reason' AS reason FROM alerts WHERE kind = 'frozen_order' AND order_id = $1",
        [b.order_id],
      ),
    ).toEqual([{ unit_id: null, reason: 'precapture_reference_p2' }]);
  });
});
