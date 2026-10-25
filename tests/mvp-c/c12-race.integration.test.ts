// MVP-C offline acceptance C-12 race_webhook_poller (mvp-plan MVP-C table; nfr.md P2, P4): a verified
// webhook and the poller (and, in a second case, the buyer's own return) act on one order at the same
// time. The order moves to paid once, books one sale, unlocks one item and sends one capture. The
// Wire is a fake that plays PayPal with the dry-run model; no byte leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootRig,
  delivery,
  eventBody,
  nowTransmissionTime,
  orderStatus,
  placeAndCheckout,
} from './c-support';
import type { CRig } from './c-support';

vi.mock('server-only', () => ({}));

describe('C-12 race_webhook_poller (offline)', () => {
  let rig: CRig;
  beforeEach(async () => {
    rig = await bootRig();
  });
  afterEach(async () => {
    await rig?.close();
  });

  const effects = async (order_id: string) => ({
    status: await orderStatus(rig, order_id),
    sales: await rig.count(
      `SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'`,
      [order_id],
    ),
    capture_ids: await rig.count(
      'SELECT count(DISTINCT capture_id) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL',
      [order_id],
    ),
    entitlements: await rig.count(
      `SELECT count(*) AS c FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
      [order_id],
    ),
    receipts: await rig.count('SELECT count(*) AS c FROM receipts WHERE order_id = $1', [order_id]),
    capture_ops: await rig.count(
      `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND kind = 'capture'`,
      [order_id],
    ),
    open_ops: await rig.count(
      `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND state IN ('prepared','sent','unknown')`,
      [order_id],
    ),
  });

  const hook = (o: { order: string; n: number }) =>
    delivery(
      eventBody({
        id: `WH-C12-${o.n}`,
        type: 'PAYMENT.CAPTURE.COMPLETED',
        order: o.order,
        capture: `${o.order}CAP1`,
      }),
      { id: `TR-C12-${o.n}`, time: nowTransmissionTime() },
    );

  it('C-12 the webhook and the poller on one order at once: one transition to paid, one sale, one capture', async () => {
    const offers = ['knot-notebook', 'ferry-timetables', 'harbour-fees'] as const;
    for (const [n, offer] of offers.entries()) {
      // the capture was sent and its answer was lost: the order waits for a read-back
      const placed = await placeAndCheckout(rig, {
        offer,
        option: 'online_read',
        scenario: 'lost_capture_response',
      });
      await rig.app.engine.payments.onBuyerReturn({
        order_ref: placed.order_ref,
        actor: rig.buyer,
      });
      expect(await orderStatus(rig, placed.order_id)).not.toBe('paid');
      await rig.app.db.query(
        `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE order_id = $1 AND state = 'unknown'`,
        [placed.order_id],
      );

      // at once: the verified webhook (twice) and the job loop's first pass
      const [first, second, jobs] = await Promise.all([
        rig.post(hook({ order: placed.provider_order_id, n }), `203.0.113.${100 + n}`),
        rig.post(hook({ order: placed.provider_order_id, n }), `203.0.113.${110 + n}`),
        rig.app.startJobs(),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);
      await vi.waitFor(async () => expect(await orderStatus(rig, placed.order_id)).toBe('paid'), {
        timeout: 25_000,
        interval: 200,
      });
      // let any read-back the webhook made due run too, then stop
      await vi.waitFor(async () => expect((await effects(placed.order_id)).open_ops).toBe(0), {
        timeout: 25_000,
        interval: 200,
      });
      await jobs.stop();

      expect(await effects(placed.order_id)).toEqual({
        status: 'paid',
        sales: 1,
        capture_ids: 1,
        entitlements: 1,
        receipts: 1,
        capture_ops: 1,
        open_ops: 0,
      });
      // PayPal saw one capture for this order, however the two paths interleaved
      expect(
        rig.sent.filter(
          (r) => r.method === 'POST' && r.url.endsWith(`/${placed.provider_order_id}/capture`),
        ),
      ).toHaveLength(1);
    }
    // the books balance across the three orders
    expect(await rig.count(`SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'`)).toBe(3);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(3);
  }, 120_000);

  it("C-12 the webhook and the buyer's own return at once: one capture sent, one sale", async () => {
    const placed = await placeAndCheckout(rig, { offer: 'tide-tables', option: 'online_read' });
    const [ret, hookRes] = await Promise.all([
      rig.app.engine.payments.onBuyerReturn({ order_ref: placed.order_ref, actor: rig.buyer }),
      rig.post(hook({ order: placed.provider_order_id, n: 9 })),
    ]);
    expect(ret.ok).toBe(true);
    expect(hookRes.status).toBe(200);
    expect(await orderStatus(rig, placed.order_id)).toBe('paid');
    const e = await effects(placed.order_id);
    expect(e).toMatchObject({
      sales: 1,
      capture_ids: 1,
      entitlements: 1,
      receipts: 1,
      capture_ops: 1,
    });
    expect(
      rig.sent.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/${placed.provider_order_id}/capture`),
      ),
    ).toHaveLength(1);
  }, 60_000);
});
