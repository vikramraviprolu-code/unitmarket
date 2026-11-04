// MC2-L6 (D-083): a capture PayPal leaves pending for the seller to accept. The reason comes from the
// recorded synthetic fixture, not from a typed string. The unit ends `pending`, the entitlement stays
// locked, nothing is booked, and the later COMPLETED capture unlocks it by the existing path. Real PGlite,
// scripted PayPal; no money state, ledger or recovery rule is changed by this lane.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrderRead } from '@umsbx/contracts';
import { loadOrderView, onBuyerReturn, readApplyGates, applyReadback } from './index';
import { pendingReasonKind } from './pending-reason';
import { BUYER_A, approved, count, makeWorld } from './support';
import type { Awaiting, World } from './support';

type Read = Extract<OrderRead, { kind: 'order' }>;
let w: World;

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../fixtures/paypal/synthetic/pending_receiving_pref__get_capture__1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { response: { body: { id: string; status: string; status_details: { reason: string } } } };
const REASON = fixture.response.body.status_details.reason;

async function sentCapture(): Promise<Awaiting> {
  const a = await approved(w, {});
  w.paypal.crashAfterCapture = true;
  await expect(onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A })).rejects.toThrow();
  w.paypal.crashAfterCapture = false;
  return a;
}
const readOf = async (a: Awaiting): Promise<Read> => {
  const r = await w.paypal.getOrder(a.provider_order_id);
  if (r.kind !== 'order') throw new Error('no read');
  return r;
};
const withCapture = (r: Read, status: 'PENDING' | 'COMPLETED', reason: string | null): Read => ({
  ...r,
  units: r.units.map((u) => ({
    ...u,
    capture: {
      capture_id: fixture.response.body.id,
      status,
      status_reason: reason,
      amount: u.amount,
      paypal_fee_minor: status === 'COMPLETED' ? 45 : null,
      refunded_minor: 0,
    },
  })),
});
const unitOf = async (order_id: string) =>
  (
    await w.rows<Record<string, unknown>>('SELECT * FROM order_units WHERE order_id = $1', [
      order_id,
    ])
  )[0]!;

describe('a capture pending for seller acceptance', () => {
  it('the recorded fixture carries the reason the mapping knows', () => {
    expect(fixture.response.body.status).toBe('PENDING');
    expect(pendingReasonKind(REASON)).toBe('awaiting_seller_acceptance');
  });
});

describe('the later COMPLETED capture', () => {
  afterEach(async () => {
    expect(w.paypal.violations).toEqual([]);
    await w.close();
  });

  it('ends pending and locked with the reason stored, then unlocks on the later COMPLETED capture', async () => {
    w = await makeWorld();
    const a = await sentCapture();
    const base = await readOf(a);
    const gates = await readApplyGates(w.deps, a.order_id);
    const apply = (read: Read) =>
      w.db.transaction((tx) =>
        applyReadback(tx, w.deps, {
          order_id: a.order_id,
          read,
          trigger: 'poll',
          ...(gates === null ? {} : { gates }),
        }),
      );

    const pend = await apply(withCapture(base, 'PENDING', REASON));
    expect(pend.order_status).toBe('unresolved');
    expect(pend.unlocked).toEqual([]);
    expect(await unitOf(a.order_id)).toMatchObject({ status: 'pending', status_reason: REASON });
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual([
      { money_state: 'pending', access_state: 'locked' },
    ]);
    expect(await count(w, 'ledger_entries')).toBe(0);
    const view = await loadOrderView(w.db, a.order_id);
    expect(view.items[0]!.access).toBe('locked');
    expect(view.buyer_message).not.toContain(REASON);

    w.clock.advance(120_000);
    const done = await apply(withCapture(base, 'COMPLETED', null));
    expect(done.order_status).toBe('paid');
    expect(done.unlocked).toHaveLength(1);
    expect(await unitOf(a.order_id)).toMatchObject({
      status: 'captured_verified',
      status_reason: null,
    });
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });
});
