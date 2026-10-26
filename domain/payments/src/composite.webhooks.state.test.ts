// DP-2b (MVP-D): a verified webhook makes due the read-back of the PayPal order it names, and of no
// other. Real PGlite, scripted PayPal. A pack is the approval of ofr_1 and ofr_3.
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, ProviderEvent } from '@umsbx/contracts';
import { handleWebhook, onBuyerReturn } from './index';
import { BUYER_A, approved, makeWorld, providerOrdersOf } from './ops/support';
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
  // A webhook never calls PayPal itself.
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);
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
    occurred_at: w.clock.now().toISOString(),
    ...o,
  };
};
const deliver = (e: ProviderEvent) =>
  handleWebhook(w.deps, {
    verdict: { kind: 'verified', event: e },
    transmission_id: e.transmission_id,
    received_at: w.clock.now().toISOString(),
  });
const readbacks = (order_id: string) =>
  w.rows<{ request_id: string; state: string; next_retry_at: Date | null }>(
    `SELECT o.request_id, o.state, o.next_retry_at FROM operations o
       LEFT JOIN provider_orders p ON p.id = o.provider_order_ref
      WHERE o.order_id = $1 AND o.kind = 'readback' ORDER BY p.position, o.id`,
    [order_id],
  );

describe('a webhook and a pack', () => {
  it("PO2 event makes only PO2's read-back due", async () => {
    w = await world();
    const a = await approved(w, PACK);
    // PO1 captured and read back; PO2's capture answer is lost: nothing has read PO2 yet
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    expect((await providerOrdersOf(w, a.order_id)).map((p) => p.state)).toEqual([
      'captured',
      'unresolved',
    ]);
    expect((await readbacks(a.order_id)).map((o) => [o.request_id, o.state])).toEqual([
      [`umsB-${a.order_ref}-p1`, 'confirmed'],
    ]);

    // an event that names PO2 by its PayPal order id
    const r = await deliver(ev({ provider_order_id: poIds(a)[1]! }));
    expect(r).toEqual({ http: 200, outcome: 'enqueued' });
    const after = await readbacks(a.order_id);
    expect(after.map((o) => [o.request_id, o.state])).toEqual([
      [`umsB-${a.order_ref}-p1`, 'confirmed'], // PO1's settled read-back is not opened again
      [`umsB-${a.order_ref}-p2`, 'unknown'],
    ]);
    expect(after[1]!.next_retry_at!.toISOString()).toBe(w.clock.now().toISOString()); // due now
    expect(w.paypal.violations).toEqual([]);

    // an event that names PO1 by its capture id reopens PO1's read-back, and not PO2's
    const cap = (
      await w.rows<{ capture_id: string }>(
        "SELECT capture_id FROM order_units WHERE order_id = $1 AND publisher_id = 'pub_1'",
        [a.order_id],
      )
    )[0]!.capture_id;
    w.clock.advance(5 * 60_000);
    const r1 = await deliver(ev({ capture_id: cap }));
    expect(r1).toEqual({ http: 200, outcome: 'enqueued' });
    const last = await readbacks(a.order_id);
    expect(last.map((o) => [o.request_id, o.state])).toEqual([
      [`umsB-${a.order_ref}-p1`, 'unknown'],
      [`umsB-${a.order_ref}-p2`, 'unknown'],
    ]);
    expect(last[0]!.next_retry_at!.toISOString()).toBe(w.clock.now().toISOString());
    expect(last[1]!.next_retry_at!.toISOString()).toBe(after[1]!.next_retry_at!.toISOString());
  });

  it('an event for a PayPal order nobody has captured is a no-op, even when its sibling was captured', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'blocked', by: 'kill_switch' });
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    expect((await providerOrdersOf(w, a.order_id)).map((p) => p.state)).toEqual([
      'captured',
      'approved',
    ]);
    const r = await deliver(
      ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: poIds(a)[1]! }),
    );
    expect(r).toEqual({ http: 200, outcome: 'no_op' });
    expect((await readbacks(a.order_id)).map((o) => [o.request_id, o.state])).toEqual([
      [`umsB-${a.order_ref}-p1`, 'confirmed'],
    ]);
  });
});
