// MVP-B offline acceptance, run against the dry-run transport and model (no network, no credential):
//   B-06 kill_switch_mid_flow, B-07 client_timeout_reconciles, B-08 call_budget.
// The real-sandbox twins of these run in the owner sessions; here the same assertions run in CI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditSink } from '@umsbx/obs';
import { cryptoIds, systemClock } from '@umsbx/runtime';
import { setSwitch } from '@umsbx/safety';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../../apps/web/composition.server';
import { bootApp, buyerOf, callRows, checkoutAndApprove, one, placeOrder } from './journey';

vi.mock('server-only', () => ({}));

let app: App;
let actor: Actor;
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_test', mfa: true };

beforeEach(async () => {
  app = await bootApp();
  actor = await buyerOf(app);
});
afterEach(async () => {
  await app.close();
});

const sales = (order_id: string): Promise<number> =>
  one(
    app,
    "SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'",
    [order_id],
  );
const captureIds = (order_id: string): Promise<number> =>
  one(
    app,
    'SELECT count(DISTINCT capture_id) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL',
    [order_id],
  );
const status = async (order_ref: string): Promise<string | undefined> =>
  (await app.engine.orderView({ order_ref, actor }))?.status;

describe('B-06 kill_switch_mid_flow', () => {
  it('tripped between approval and capture: the call is blocked; after reset the order completes with one capture', async () => {
    const audit = createAuditSink(cryptoIds(), systemClock());
    const order = await placeOrder(app, actor);
    await checkoutAndApprove(app, actor, order, 'happy');
    const before = await callRows(app);

    const tripped = await setSwitch(app.db, audit, systemClock(), {
      name: 'paypal_outbound',
      on: false,
      by: OPERATOR,
      reason: 'b-06 trip',
      approval_ref: null,
    });
    expect(tripped.ok).toBe(true);

    const blocked = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('payments_paused');
    // Blocked means no capture reached the transport and nothing was booked.
    const during = await callRows(app);
    expect(during.filter((c) => c.operation === 'capture_order' && c.outcome !== 'blocked')).toEqual(
      [],
    );
    expect(during.length - before.length).toBeLessThanOrEqual(1);
    expect(await sales(order.order_id)).toBe(0);
    expect(await captureIds(order.order_id)).toBe(0);
    expect(await status(order.order_ref)).not.toBe('paid');

    // Reset (start) needs an active owner approval row (D-006); insert one as the CLI would.
    await app.db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_b06', 'b06-ref', 'b06', ARRAY['create_order','capture_order'], 100000, 50, '2999-01-01T00:00:00Z', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    const reset = await setSwitch(app.db, audit, systemClock(), {
      name: 'paypal_outbound',
      on: true,
      by: OPERATOR,
      reason: 'b-06 reset',
      approval_ref: 'b06-ref',
    });
    expect(reset.ok).toBe(true);

    const back = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(back.ok).toBe(true);
    expect(await status(order.order_ref)).toBe('paid');
    expect(await sales(order.order_id)).toBe(1);
    expect(await captureIds(order.order_id)).toBe(1);
    expect(
      (await callRows(app)).filter((c) => c.operation === 'capture_order' && c.http_status === 201),
    ).toHaveLength(1);
  });
});

describe('B-07 client_timeout_reconciles (REL-3)', () => {
  it('a timed-out capture is resolved by read-back, never by a second capture; one capture, one sale', async () => {
    const order = await placeOrder(app, actor);
    await checkoutAndApprove(app, actor, order, 'lost_capture_response');
    const r = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'lost_capture_response',
    });
    // The client saw a timeout: the buyer is told it is being confirmed, nothing is booked yet.
    expect(await status(order.order_ref)).not.toBe('paid');
    expect(r.ok ? r.value.status : 'refused').not.toBe('paid');
    expect(await sales(order.order_id)).toBe(0);
    const timedOut = (await callRows(app)).filter((c) => c.operation === 'capture_order');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]!.outcome).toMatch(/timeout/);

    // The reconciler (the job loop) reads the order back and settles it.
    await app.db.query(
      `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE state = 'unknown'`,
    );
    const jobs = await app.startJobs();
    await vi.waitFor(async () => expect(await status(order.order_ref)).toBe('paid'), {
      timeout: 8000,
      interval: 100,
    });
    await jobs.stop();

    expect(await sales(order.order_id)).toBe(1);
    expect(await captureIds(order.order_id)).toBe(1);
    const after = await callRows(app);
    // REL-3: no further capture was sent after the lost answer.
    expect(after.filter((c) => c.operation === 'capture_order')).toHaveLength(1);
    expect(after.filter((c) => c.operation === 'get_order').length).toBeGreaterThanOrEqual(1);
  });
});

describe('B-08 call_budget', () => {
  it('one happy order makes at most 6 PayPal calls in provider_calls (token, create, pre-capture GET, capture, post-capture GET, capture GET)', async () => {
    const order = await placeOrder(app, actor);
    await checkoutAndApprove(app, actor, order, 'happy');
    const r = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(r.ok).toBe(true);
    expect(await status(order.order_ref)).toBe('paid');

    const calls = await callRows(app);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(6);
    const count = (op: string): number => calls.filter((c) => c.operation === op).length;
    expect(count('create_order')).toBe(1);
    expect(count('capture_order')).toBe(1);
    // A later pass of the loop with nothing due adds no call.
    const jobs = await app.startJobs();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await jobs.stop();
    expect((await callRows(app)).length).toBe(calls.length);
  });
});
