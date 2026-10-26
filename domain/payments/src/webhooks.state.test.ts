// State tests of webhook intake (lane CO-2, ASM-60). A verified webhook is never evidence of
// payment: it is stored once and makes the order's read-back due, and nothing else. The read-back
// (reconciler) decides, so the order of arrival does not matter. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent, SqlExecutor, WebhookVerdict } from '@umsbx/contracts';
import { executeRefund, handleWebhook, onBuyerReturn, requestRefund, runDue } from './index';
import {
  BUYER_A,
  OPERATOR,
  alertKinds,
  approved,
  count,
  lostResponse,
  makeWorld,
  ops,
  paid,
  setOrderStatus,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  // A webhook never calls PayPal itself, and no read happens inside a transaction.
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const H = 3_600_000;
const iso = (ms = 0): string => new Date(w.clock.now().getTime() + ms).toISOString();

async function world(): Promise<void> {
  w = await makeWorld();
  let n = 0;
  // An audit sink that really writes audit_log rows (the world's own sink is a no-op).
  w.deps = {
    ...w.deps,
    audit: {
      record: async (tx: SqlExecutor, e) => {
        n += 1;
        await tx.query(
          `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7, $7)`,
          [
            `aud_t${n}`,
            e.actor.kind,
            e.action,
            e.target,
            e.reason,
            JSON.stringify(e.detail),
            iso(),
          ],
        );
      },
    },
  };
}

let seq = 0;
const ev = (o: Partial<ProviderEvent> = {}): ProviderEvent => {
  seq += 1;
  return {
    event_id: `WH-EVT-${seq}`,
    transmission_id: `tx-${seq}`,
    type: 'PAYMENT.CAPTURE.COMPLETED',
    provider_order_id: null,
    capture_id: null,
    refund_id: null,
    occurred_at: iso(),
    ...o,
  };
};
const deliver = (e: ProviderEvent) =>
  handleWebhook(w.deps, {
    verdict: { kind: 'verified', event: e },
    transmission_id: e.transmission_id,
    received_at: iso(),
  });
const deliverVerdict = (verdict: WebhookVerdict, transmission_id = 'tx-raw') =>
  handleWebhook(w.deps, { verdict, transmission_id, received_at: iso() });

const unitOf = async (order_id: string) =>
  (
    await w.rows<{
      id: string;
      status: string;
      capture_id: string | null;
      captured_verified_at: Date | null;
      refunded_minor: number;
    }>(
      'SELECT id, status, capture_id, captured_verified_at, refunded_minor FROM order_units WHERE order_id = $1',
      [order_id],
    )
  )[0]!;
const orderStatus = async (order_id: string) =>
  (await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [order_id]))[0]!
    .status;
const readback = async (order_id: string) => {
  const found = (await ops(w, order_id)).filter((o) => o.kind === 'readback');
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0] ?? null;
};
const opRows = (order_id: string) =>
  w.rows(
    `SELECT id, kind, state, attempt, failure_reason, next_retry_at, reconcile_until, updated_at
       FROM operations WHERE order_id = $1 ORDER BY id`,
    [order_id],
  );
const ent = async (order_id: string) =>
  w.rows<{ money_state: string; access_state: string }>(
    `SELECT e.money_state, e.access_state FROM entitlements e
       JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1 ORDER BY e.id`,
    [order_id],
  );
const ledger = (order_id: string) =>
  w.rows<{ kind: string; n: number }>(
    `SELECT l.kind, count(*)::int AS n FROM ledger_entries l
       JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 GROUP BY l.kind ORDER BY l.kind`,
    [order_id],
  );
const events = () =>
  w.rows<{
    event_id: string;
    transmission_id: string;
    type: string;
    verified: boolean;
    outcome: string | null;
    resource: Record<string, unknown>;
    environment: string;
  }>(
    'SELECT event_id, transmission_id, type, verified, outcome, resource, environment FROM webhook_events ORDER BY event_id',
  );

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await w.rows<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const out: Record<string, number> = {};
  for (const t of tables) out[t.table_name] = await count(w, t.table_name);
  return out;
}

/** The capture claim is stored but the read failed: unresolved, readback operation unknown. */
async function claimStored() {
  const a = await approved(w);
  w.paypal.queue.get.push('real', { kind: 'timeout' } as never);
  const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
  if (!r.ok || r.value.status !== 'unresolved') throw new Error('expected an unresolved order');
  const unit = await unitOf(a.order_id);
  if (unit.capture_id === null) throw new Error('the claim was not stored');
  return { ...a, capture_id: unit.capture_id, unit_id: unit.id };
}
async function refundFully(order_id: string): Promise<{ unit_id: string; capture_id: string }> {
  const unit = await unitOf(order_id);
  const r = await requestRefund(w.deps, {
    unit_id: unit.id,
    amount: null,
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refund refused: ${r.error.code}`);
  await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
  return { unit_id: unit.id, capture_id: unit.capture_id as string };
}

describe('a verified event makes the read-back due and does nothing else', () => {
  it('genuine COMPLETED enqueues one read-back and never sets paid (C-01 offline twin)', async () => {
    await world();
    const a = await claimStored();
    // The next poll is an hour away; the event must bring it forward to now.
    await w.rows('UPDATE operations SET next_retry_at = $2 WHERE order_id = $1 AND kind = $3', [
      a.order_id,
      iso(H),
      'readback',
    ]);
    const calls = w.paypal.calls.length;
    const before = await ledger(a.order_id);

    const r = await deliver(ev({ capture_id: a.capture_id }));
    expect(r).toEqual({ http: 200, outcome: 'enqueued' });

    // No state came from the webhook.
    expect(await orderStatus(a.order_id)).toBe('unresolved');
    expect(await unitOf(a.order_id)).toMatchObject({
      status: 'expected',
      captured_verified_at: null,
    });
    expect(await ent(a.order_id)).toEqual([{ money_state: 'pending', access_state: 'locked' }]);
    expect(await ledger(a.order_id)).toEqual(before);
    expect(await count(w, 'ledger_entries')).toBe(0);
    expect(await count(w, 'alerts')).toBe(0);
    expect(w.paypal.calls.length).toBe(calls);

    // One stored event, one read-back, due now.
    expect(await events()).toHaveLength(1);
    const op = await readback(a.order_id);
    expect(op).toMatchObject({ kind: 'readback', state: 'unknown' });
    expect(op!.next_retry_at!.toISOString()).toBe(iso());

    // The read-back decides.
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(a.order_id)).toBe('paid');
    expect(await ledger(a.order_id)).toContainEqual({ kind: 'sale', n: 1 });
  });

  it('stores the event as ids only, never the body, with the configured environment', async () => {
    await world();
    const a = await claimStored();
    const e = ev({ capture_id: a.capture_id, occurred_at: '2026-10-22T09:59:00.000Z' });
    await deliver(e);
    const rows = await events();
    expect(rows).toEqual([
      {
        event_id: e.event_id,
        transmission_id: e.transmission_id,
        type: 'PAYMENT.CAPTURE.COMPLETED',
        verified: true,
        outcome: expect.any(String),
        resource: {
          capture_id: a.capture_id,
          refund_id: null,
          provider_order_id: null,
          occurred_at: '2026-10-22T09:59:00.000Z',
        },
        environment: 'dryrun',
      },
    ]);
  });

  it('same event 3 times: one enqueue, 200 each (P2, C-05)', async () => {
    await world();
    const a = await paid(w);
    const { capture_id } = await unitOf(a.order_id).then((u) => ({ capture_id: u.capture_id! }));
    const e = ev({ capture_id });
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'enqueued' });
    expect((await readback(a.order_id))!.state).toBe('unknown');
    await runDue(w.deps, { max_items: 10 }); // the read-back runs and settles
    expect((await readback(a.order_id))!.state).toBe('confirmed');
    const settled = await opRows(a.order_id);

    w.tick(2 * H);
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'duplicate' });
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'duplicate' });
    expect(await events()).toHaveLength(1);
    expect(await opRows(a.order_id)).toEqual(settled);
  });

  it('replay after a full refund leaves access revoked once the read-back runs (C-05)', async () => {
    await world();
    const a = await paid(w);
    const { capture_id } = await refundFully(a.order_id);
    expect(await ent(a.order_id)).toEqual([{ money_state: 'refunded', access_state: 'revoked' }]);
    const entBefore = await ent(a.order_id);
    const ledgerBefore = await ledger(a.order_id);
    const accessEvents = await count(w, 'access_events');
    const receipts = await count(w, 'receipts');

    const e = ev({ capture_id });
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'enqueued' });
    await runDue(w.deps, { max_items: 10 });
    // The same event again, and a fresh COMPLETED for the same capture.
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'duplicate' });
    expect(await deliver(ev({ capture_id }))).toEqual({ http: 200, outcome: 'enqueued' });
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });

    expect(await ent(a.order_id)).toEqual(entBefore);
    expect(await unitOf(a.order_id)).toMatchObject({ status: 'refunded', refunded_minor: 400 });
    expect(await ledger(a.order_id)).toEqual(ledgerBefore);
    expect(await count(w, 'access_events')).toBe(accessEvents);
    expect(await count(w, 'receipts')).toBe(receipts);
  });

  it('REFUNDED then COMPLETED delivered out of order: final state equals the read-back, item not unlocked again', async () => {
    await world();
    // Three refunded orders: A gets REFUNDED then COMPLETED, B the reverse, C no webhook at all.
    const a = await paid(w, { offers: ['ofr_1'] });
    const b = await paid(w, { offers: ['ofr_2'] });
    const c = await paid(w, { offers: ['ofr_3'] });
    const ca = await refundFully(a.order_id);
    const cb = await refundFully(b.order_id);
    await refundFully(c.order_id);
    const earlier = iso(-60_000);

    await deliver(ev({ type: 'PAYMENT.CAPTURE.REFUNDED', capture_id: ca.capture_id }));
    await deliver(ev({ capture_id: ca.capture_id, occurred_at: earlier }));
    await deliver(ev({ capture_id: cb.capture_id, occurred_at: earlier }));
    await deliver(ev({ type: 'PAYMENT.CAPTURE.REFUNDED', capture_id: cb.capture_id }));
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });

    const snap = async (o: { order_id: string }) => ({
      order: await orderStatus(o.order_id),
      unit: (({ status, refunded_minor }) => ({ status, refunded_minor }))(
        await unitOf(o.order_id),
      ),
      ent: await ent(o.order_id),
      ledger: await ledger(o.order_id),
    });
    const sa = await snap(a);
    expect(sa.ent).toEqual([{ money_state: 'refunded', access_state: 'revoked' }]);
    expect(await snap(b)).toEqual(sa);
    expect(await snap(c)).toEqual(sa);
  });

  it('REVERSED is a hint: read-back due and one alert, the unit and the money are untouched (ASM-63)', async () => {
    await world();
    const a = await paid(w);
    const { capture_id } = await unitOf(a.order_id).then((u) => ({ capture_id: u.capture_id! }));
    const ledgerBefore = await ledger(a.order_id);
    expect(await deliver(ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id }))).toEqual({
      http: 200,
      outcome: 'enqueued',
    });
    // Nothing changed in the money state.
    expect((await unitOf(a.order_id)).status).toBe('captured_verified');
    expect(await ent(a.order_id)).toEqual([{ money_state: 'captured', access_state: 'available' }]);
    expect(await ledger(a.order_id)).toEqual(ledgerBefore);
    expect(await count(w, 'ledger_entries', "kind = 'reversal'")).toBe(0);
    // One alert, as a hint (its own kind, so recovery opens no case from it); the read-back is due.
    expect(await alertKinds(w, a.order_id)).toEqual(['reversal_hint']);
    const [alert] = await w.rows<{ detail: Record<string, unknown>; unit_id: string }>(
      'SELECT detail, unit_id FROM alerts WHERE order_id = $1',
      [a.order_id],
    );
    expect(alert!.detail).toEqual({
      reason: 'reversal_hint',
      source: 'webhook',
      capture_id,
    });
    expect(alert!.unit_id).toBe((await unitOf(a.order_id)).id);
    expect((await readback(a.order_id))!.state).toBe('unknown');

    // Another delivery of a reversal for the same capture raises nothing new.
    await deliver(ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id }));
    expect(await count(w, 'alerts', "kind = 'reversal_hint'")).toBe(1);
    expect(await count(w, 'alerts', "kind = 'reversal'")).toBe(0);
    expect((await unitOf(a.order_id)).status).toBe('captured_verified');

    // The read-back runs, PayPal still shows the capture as completed: nothing moves.
    await runDue(w.deps, { max_items: 10 });
    expect((await unitOf(a.order_id)).status).toBe('captured_verified');
    expect(await ent(a.order_id)).toEqual([{ money_state: 'captured', access_state: 'available' }]);
  });

  it('P1: a forged REVERSED on a paid unit leaves it captured_verified, a refund is still allowed, the read-back runs', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    await deliver(ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id: u.capture_id }));
    expect((await unitOf(a.order_id)).status).toBe('captured_verified');
    const r = await requestRefund(w.deps, {
      unit_id: u.id,
      amount: null,
      reason: 'goodwill',
      actor: OPERATOR,
    });
    expect(r.ok).toBe(true);
    const gets = w.paypal.count('get');
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(gets + 1);
  });

  it('P1b: a refund in flight (answer lost) then a forged REVERSED: the refund is booked, unit refunded, access revoked', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const r = await requestRefund(w.deps, {
      unit_id: u.id,
      amount: null,
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refund refused');
    w.refundNext.lose_response = true;
    await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    w.refundNext.lose_response = false;
    await deliver(ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id: u.capture_id }));
    expect((await unitOf(a.order_id)).status).toBe('captured_verified');
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await unitOf(a.order_id)).toMatchObject({ status: 'refunded', refunded_minor: 400 });
    expect(await ent(a.order_id)).toEqual([{ money_state: 'refunded', access_state: 'revoked' }]);
    expect(await count(w, 'ledger_entries', "kind = 'refund'")).toBe(1);
  });

  it('a reversal that PayPal shows in the read (DECLINED) is what marks reversal_suspected', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    await deliver(ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id: u.capture_id }));
    w.forceStatus(u.capture_id!, 'DECLINED');
    w.tick(60_000);
    await runDue(w.deps, { max_items: 10 });
    expect((await unitOf(a.order_id)).status).toBe('reversal_suspected');
    expect(await count(w, 'ledger_entries', "kind = 'reversal'")).toBe(0);
    // the hint, and the alert the read evidence raised
    expect(await alertKinds(w, a.order_id)).toEqual(['reversal', 'reversal_hint']);
  });

  it('webhook_enabled off: 503 and nothing stored', async () => {
    await world();
    const a = await paid(w);
    const { capture_id } = await unitOf(a.order_id).then((u) => ({ capture_id: u.capture_id! }));
    w.switches.webhook_enabled = false;
    const counts = await tableCounts();
    const rows = await opRows(a.order_id);

    expect(await deliver(ev({ capture_id }))).toEqual({ http: 503, outcome: 'disabled' });
    expect(await deliverVerdict({ kind: 'bad_signature', why: 'x' })).toEqual({
      http: 503,
      outcome: 'disabled',
    });
    expect(await deliverVerdict({ kind: 'unverifiable' })).toEqual({
      http: 503,
      outcome: 'disabled',
    });
    expect(await tableCounts()).toEqual(counts);
    expect(await opRows(a.order_id)).toEqual(rows);

    // PayPal retries; once the switch is on again the same delivery is accepted.
    w.switches.webhook_enabled = true;
    const e = ev({ capture_id });
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'enqueued' });
  });

  it('unknown type stored, no_op', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    const rows = await opRows(a.order_id);
    const ids = { capture_id: u.capture_id, refund_id: 'REF1', provider_order_id: 'ORD1' };
    expect(await deliver(ev({ type: 'OTHER', ...ids }))).toEqual({ http: 200, outcome: 'no_op' });
    expect(await deliver(ev({ type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED', ...ids }))).toEqual({
      http: 200,
      outcome: 'no_op',
    });
    expect((await events()).map((e) => [e.type, e.outcome])).toEqual([
      ['OTHER', 'no_op'],
      ['CHECKOUT.PAYMENT-APPROVAL.REVERSED', 'no_op'],
    ]);
    expect(await opRows(a.order_id)).toEqual(rows);
    expect(await count(w, 'alerts')).toBe(0);
  });

  it('capture id that is not ours: no_op', async () => {
    await world();
    const a = await paid(w);
    const rows = await opRows(a.order_id);
    const counts = await tableCounts();
    expect(await deliver(ev({ capture_id: 'NOTOURS123' }))).toEqual({
      http: 200,
      outcome: 'no_op',
    });
    // A reversal for a capture that is not ours changes and alerts nothing either.
    expect(
      await deliver(ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id: 'NOTOURS124' })),
    ).toEqual({ http: 200, outcome: 'no_op' });
    expect(await opRows(a.order_id)).toEqual(rows);
    expect(await tableCounts()).toEqual({
      ...counts,
      webhook_events: counts['webhook_events']! + 2,
    });
  });
});

describe('finding the order', () => {
  it('a refund event without the capture link is found by the provider refund id', async () => {
    await world();
    const a = await paid(w);
    const { unit_id } = await refundFully(a.order_id);
    const refund_id = (
      await w.rows<{ refund_id: string }>(
        'SELECT refund_id FROM refund_requests WHERE unit_id = $1',
        [unit_id],
      )
    )[0]!.refund_id;
    expect(await deliver(ev({ type: 'PAYMENT.CAPTURE.REFUNDED', refund_id }))).toEqual({
      http: 200,
      outcome: 'enqueued',
    });
    expect((await readback(a.order_id))!.state).toBe('unknown');
    expect(await deliver(ev({ type: 'PAYMENT.CAPTURE.REFUNDED', refund_id: 'NOREFUND1' }))).toEqual(
      {
        http: 200,
        outcome: 'no_op',
      },
    );
  });

  it('CHECKOUT.ORDER.APPROVED is found by the provider order id and creates the read-back (capture in doubt)', async () => {
    await world();
    const a = await lostResponse(w); // a capture operation is unknown, no read-back operation yet
    expect(await readback(a.order_id)).toBeNull();
    expect(
      await deliver(
        ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: a.provider_order_id }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    const op = (await readback(a.order_id))!;
    expect(op).toMatchObject({ kind: 'readback', state: 'unknown', attempt: 1 });
    expect(op.request_id).toBe(`umsB-${a.order_ref}`);
    expect(op.next_retry_at!.toISOString()).toBe(iso());
    const created = await w.rows<{ reconcile_until: Date }>(
      "SELECT reconcile_until FROM operations WHERE order_id = $1 AND kind = 'readback'",
      [a.order_id],
    );
    expect(created[0]!.reconcile_until.toISOString()).toBe(iso(86_400_000));
    expect(await orderStatus(a.order_id)).toBe('unresolved');

    // Not our order: stored, no_op.
    expect(
      await deliver(ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: 'NOSUCHORDER' })),
    ).toEqual({ http: 200, outcome: 'no_op' });
    // The capture id is no key for an order event.
    expect(await deliver(ev({ type: 'CHECKOUT.ORDER.APPROVED', capture_id: 'WHATEVER' }))).toEqual({
      http: 200,
      outcome: 'no_op',
    });
  });

  it('a settled read-back is opened again, due now, with a window', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    expect((await readback(a.order_id))!.state).toBe('confirmed');
    w.tick(10 * H);
    await deliver(ev({ capture_id: u.capture_id }));
    const op = (await readback(a.order_id))!;
    expect(op).toMatchObject({ state: 'unknown', failure_reason: null });
    expect(op.next_retry_at!.toISOString()).toBe(iso());
    const [row] = await w.rows<{ reconcile_until: Date }>(
      "SELECT reconcile_until FROM operations WHERE order_id = $1 AND kind = 'readback'",
      [a.order_id],
    );
    expect(row!.reconcile_until.toISOString()).toBe(iso(86_400_000));
  });
});

describe('coalescing: at most one read-back per order within 60 s (ASM-60)', () => {
  async function setRetry(order_id: string, ms: number): Promise<void> {
    await w.rows(
      "UPDATE operations SET state = 'unknown', next_retry_at = $2, reconcile_until = $3, failure_reason = NULL WHERE order_id = $1 AND kind = 'readback'",
      [order_id, iso(ms), iso(86_400_000)],
    );
  }

  it('due in 59 s: nothing changes; due in 61 s: brought forward to now', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);

    await setRetry(a.order_id, 59_000);
    const before = await opRows(a.order_id);
    expect(await deliver(ev({ capture_id: u.capture_id }))).toEqual({
      http: 200,
      outcome: 'enqueued',
    });
    expect(await opRows(a.order_id)).toEqual(before);

    await setRetry(a.order_id, 61_000);
    await deliver(ev({ capture_id: u.capture_id }));
    expect((await readback(a.order_id))!.next_retry_at!.toISOString()).toBe(iso());
  });

  it('two different events for one order in a row: the second changes nothing', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    await deliver(ev({ capture_id: u.capture_id }));
    const after1 = await opRows(a.order_id);
    w.tick(10_000);
    expect(
      await deliver(ev({ type: 'PAYMENT.CAPTURE.PENDING', capture_id: u.capture_id })),
    ).toEqual({
      http: 200,
      outcome: 'enqueued',
    });
    expect(await opRows(a.order_id)).toEqual(after1);
    expect(await events()).toHaveLength(2);
  });

  it('a read-back claimed by a worker (lease ahead) is not disturbed', async () => {
    await world();
    const a = await paid(w);
    const u = await unitOf(a.order_id);
    // claimed: state unknown, next_retry_at one lease (60 s) ahead
    await w.rows(
      "UPDATE operations SET state = 'unknown', next_retry_at = $2, reconcile_until = $3 WHERE order_id = $1 AND kind = 'readback'",
      [a.order_id, iso(60_000), iso(86_400_000)],
    );
    const before = await opRows(a.order_id);
    await deliver(ev({ capture_id: u.capture_id }));
    expect(await opRows(a.order_id)).toEqual(before);
  });
});

describe('a webhook is not evidence (P1)', () => {
  it('COMPLETED for a capture PayPal shows as declined: the read-back decides, the order is not paid', async () => {
    await world();
    const a = await claimStored();
    w.forceStatus(a.capture_id, 'DECLINED');
    await deliver(ev({ capture_id: a.capture_id }));
    expect(await orderStatus(a.order_id)).toBe('unresolved');
    w.tick(31_000);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(a.order_id)).not.toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(0);
    expect(await ent(a.order_id)).toEqual([expect.objectContaining({ access_state: 'locked' })]);
  });

  it('verdicts that are not verified store no event and answer 400 or 503', async () => {
    await world();
    expect(await deliverVerdict({ kind: 'bad_signature', why: 'crc' })).toEqual({
      http: 400,
      outcome: 'rejected',
    });
    expect(await deliverVerdict({ kind: 'malformed' })).toEqual({ http: 400, outcome: 'rejected' });
    expect(await deliverVerdict({ kind: 'unverifiable' })).toEqual({
      http: 503,
      outcome: 'unverifiable',
    });
    expect(await events()).toEqual([]);
  });
});

describe('a capture whose response was lost has no capture id stored (F4, C-12)', () => {
  it('COMPLETED with the provider order id wakes the read-back; the poller pass pays', async () => {
    await world();
    const a = await lostResponse(w); // PayPal captured, the answer was lost: unit expected, capture_id NULL
    expect((await unitOf(a.order_id)).capture_id).toBeNull();
    const fakeCapture = [...w.paypal.orders.values()][0]!.capture!.capture_id;
    expect(await readback(a.order_id)).toBeNull();
    expect(
      await deliver(ev({ capture_id: fakeCapture, provider_order_id: a.provider_order_id })),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    const op = (await readback(a.order_id))!;
    expect(op).toMatchObject({ kind: 'readback', state: 'unknown' });
    expect(op.next_retry_at!.toISOString()).toBe(iso());
    // The webhook decided nothing.
    expect(await orderStatus(a.order_id)).toBe('unresolved');
    expect(await count(w, 'ledger_entries')).toBe(0);
    await runDue(w.deps, { max_items: 10 });
    expect(await orderStatus(a.order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });

  it('a capture id that is not ours and an order id that is not ours: no_op', async () => {
    await world();
    await lostResponse(w);
    expect(
      await deliver(ev({ capture_id: 'NOTOURS1', provider_order_id: 'NOTOURSORDER' })),
    ).toEqual({ http: 200, outcome: 'no_op' });
  });

  it('a known capture id is used first: the order id is not looked up', async () => {
    await world();
    const a = await paid(w);
    const b = await approved(w, { offers: ['ofr_2'] });
    const capture_id = (await unitOf(a.order_id)).capture_id!;
    // The event names a's capture and b's order: only a's read-back moves.
    await deliver(ev({ capture_id, provider_order_id: b.provider_order_id }));
    expect((await readback(a.order_id))!.state).toBe('unknown');
    expect(await readback(b.order_id)).toBeNull();
  });

  it('CHECKOUT.PAYMENT-APPROVAL.REVERSED with an order id wakes the read-back (capture in doubt); without one it is no_op', async () => {
    await world();
    const a = await lostResponse(w);
    expect(
      await deliver(
        ev({
          type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
          provider_order_id: a.provider_order_id,
        }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    expect((await readback(a.order_id))!.state).toBe('unknown');
    expect(await count(w, 'alerts')).toBe(0);
    expect(await deliver(ev({ type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED' }))).toEqual({
      http: 200,
      outcome: 'no_op',
    });
  });
});

describe('R2: a webhook only wakes an order somebody has captured', () => {
  const addCaptureOp = (order_id: string, state: 'unknown' | 'confirmed' = 'unknown') =>
    w.insert('operations', {
      id: `opr_t${order_id.slice(-6)}`,
      order_id,
      kind: 'capture',
      state,
      attempt: 1,
      request_id: `umsK-test-${order_id}`,
      next_retry_at: state === 'unknown' ? iso(H) : null,
      reconcile_until: state === 'unknown' ? iso(24 * H) : null,
    });

  it('awaiting_buyer without a capture operation: no_op, no operation, and no 24 h of polling', async () => {
    await world();
    const a = await approved(w);
    const control = await approved(w, { offers: ['ofr_2'] });
    const gets = w.paypal.count('get');
    expect(
      await deliver(ev({ capture_id: 'UNKNOWNCAP1', provider_order_id: a.provider_order_id })),
    ).toEqual({ http: 200, outcome: 'no_op' });
    expect(
      await deliver(
        ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: a.provider_order_id }),
      ),
    ).toEqual({ http: 200, outcome: 'no_op' });
    expect(
      await deliver(
        ev({ type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED', provider_order_id: a.provider_order_id }),
      ),
    ).toEqual({ http: 200, outcome: 'no_op' });
    expect(await readback(a.order_id)).toBeNull();
    expect((await events()).map((e) => e.outcome)).toEqual(['no_op', 'no_op', 'no_op']);
    // 20 hours: no read-back, no read, no alert (the old behaviour polled this order every hour).
    for (let k = 0; k < 20; k += 1) {
      w.tick(H);
      await runDue(w.deps, { max_items: 10 });
    }
    expect(await readback(a.order_id)).toBeNull();
    expect(w.paypal.count('get') - gets).toBe(0);
    expect(await count(w, 'alerts')).toBe(0);
    // Later the abandonment sweep owns the order, exactly as for the control that got no webhook.
    for (let k = 0; k < 8; k += 1) {
      w.tick(H);
      await runDue(w.deps, { max_items: 10 });
    }
    const readsOf = (id: string) => w.paypal.calls.filter((c) => c.provider_order_id === id).length;
    expect(readsOf(a.provider_order_id)).toBe(readsOf(control.provider_order_id));
    expect(await alertKinds(w, a.order_id)).toEqual(await alertKinds(w, control.order_id));
    const opPairs = async (id: string) =>
      (await ops(w, id)).map((o) => `${o.kind}:${o.state}`).sort();
    expect(await opPairs(a.order_id)).toEqual(await opPairs(control.order_id));
    expect(await ent(a.order_id)).toEqual(await ent(control.order_id));
  });

  it('awaiting_buyer with a capture operation unknown: enqueued', async () => {
    await world();
    const a = await approved(w);
    await addCaptureOp(a.order_id);
    expect(
      await deliver(
        ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: a.provider_order_id }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    expect((await readback(a.order_id))!.state).toBe('unknown');
  });

  it('paid: enqueued', async () => {
    await world();
    const a = await paid(w);
    const capture_id = (await unitOf(a.order_id)).capture_id;
    expect(await deliver(ev({ capture_id }))).toEqual({ http: 200, outcome: 'enqueued' });
  });

  it.each([
    ['created', false, 'no_op'],
    ['awaiting_buyer', false, 'no_op'],
    ['awaiting_buyer', true, 'enqueued'],
    ['capture_requested', false, 'enqueued'],
    ['capture_claimed', false, 'enqueued'],
    ['unresolved', false, 'enqueued'],
    ['paid', false, 'enqueued'],
    ['paid_partial', false, 'enqueued'],
    ['failed', false, 'no_op'],
    ['failed', true, 'no_op'],
    ['abandoned', false, 'no_op'],
    ['abandoned', true, 'no_op'],
    ['frozen', false, 'no_op'],
    ['frozen', true, 'no_op'],
  ] as const)('order status %s, capture operation %s: %s', async (status, withOp, expected) => {
    await world();
    const a = await approved(w);
    if (withOp) await addCaptureOp(a.order_id);
    await setOrderStatus(w.db, a.order_id, status);
    const before = await opRows(a.order_id);
    expect(
      await deliver(
        ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: a.provider_order_id }),
      ),
    ).toEqual({ http: 200, outcome: expected });
    if (expected === 'no_op') expect(await opRows(a.order_id)).toEqual(before);
    else expect((await readback(a.order_id))!.state).toBe('unknown');
  });

  it('a REVERSED for an order nobody captured raises no hint alert', async () => {
    await world();
    const a = await approved(w);
    await deliver(
      ev({
        type: 'PAYMENT.CAPTURE.REVERSED',
        capture_id: 'CAPX',
        provider_order_id: a.provider_order_id,
      }),
    );
    expect(await count(w, 'alerts')).toBe(0);
  });

  it('the lost-capture-id case still wakes: capture operation unknown, unit expected, capture_id NULL', async () => {
    await world();
    const a = await lostResponse(w);
    expect((await unitOf(a.order_id)).capture_id).toBeNull();
    expect((await ops(w, a.order_id)).find((o) => o.kind === 'capture')!.state).toBe('unknown');
    expect(
      await deliver(ev({ capture_id: 'SBXFAKECAP00002', provider_order_id: a.provider_order_id })),
    ).toEqual({ http: 200, outcome: 'enqueued' });
  });
});

describe('the environment label comes from data (CLAUDE.md rule 7)', () => {
  it.each(['dryrun', 'sandbox'] as const)('a %s world stores %s', async (environment) => {
    await world();
    w.deps = { ...w.deps, environment };
    await deliver(ev({ capture_id: 'NOTOURS1' }));
    expect((await events()).map((e) => e.environment)).toEqual([environment]);
  });
});
