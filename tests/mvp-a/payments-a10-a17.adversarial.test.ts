// MVP-A adversarial companions to A-10 to A-17: replays, a buyer who never approved at PayPal, a
// declined capture, a hostile second buyer, a 202 claim that never settles. Expected results follow
// the requirement text: no unlock without a verified read-back, one capture, one sale. Offline only.
import { onBuyerReturn } from '@umsbx/payments';
import { describe, expect, it } from 'vitest';
import { BUYER_A, BUYER_B, buy, makeWorld, one, placeAndCheckout } from './world';
import type { World } from './world';

const n = async (w: World, sql: string) => Number((await one<{ c: string | number }>(w, sql)).c);
const ent = (w: World) =>
  one<{ money_state: string; access_state: string }>(w, 'SELECT money_state, access_state FROM entitlements LIMIT 1');

describe('adversarial: capture and read-back', () => {
  it('replaying the return after payment changes nothing: one capture, one sale, same window', async () => {
    const w = await makeWorld();
    const first = await buy(w, BUYER_A, 'tide-tables');
    const win = await one<{ started_at: Date; ends_at: Date }>(w, 'SELECT started_at, ends_at FROM access_windows LIMIT 1');
    w.td.clock.advance(3_600_000);
    for (let i = 0; i < 5; i += 1) await onBuyerReturn(w.deps, { order_ref: first.order_ref, actor: BUYER_A });
    expect(w.paypal.count('capture')).toBe(1);
    expect(await n(w, "SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'")).toBe(1);
    const after = await one<{ started_at: Date; ends_at: Date }>(w, 'SELECT started_at, ends_at FROM access_windows LIMIT 1');
    expect(new Date(after.started_at).toISOString()).toBe(new Date(win.started_at).toISOString());
    expect(new Date(after.ends_at).toISOString()).toBe(new Date(win.ends_at).toISOString());
  });

  it('a buyer who returns without approving at PayPal is not charged and nothing unlocks', async () => {
    const w = await makeWorld();
    const order = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    const ret = await onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: BUYER_A });
    expect(ret.ok).toBe(false);
    expect(w.paypal.count('capture')).toBe(0);
    expect((await ent(w)).access_state).toBe('locked');
    expect(await n(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
  });

  it('a declined capture leaves the item locked with no sale', async () => {
    const w = await makeWorld();
    w.paypal.next.status = 'DECLINED';
    await buy(w, BUYER_A, 'tide-tables');
    expect((await ent(w)).access_state).toBe('locked');
    expect(await n(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
    expect(await n(w, 'SELECT count(*) AS c FROM access_windows WHERE started_at IS NOT NULL')).toBe(0);
  });

  it('a 202 claim with no capture status never unlocks', async () => {
    const w = await makeWorld();
    w.paypal.next.claim_http = 202;
    w.paypal.next.status = 'PENDING';
    await buy(w, BUYER_A, 'tide-tables');
    expect((await ent(w)).access_state).toBe('locked');
    expect(await n(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
  });

  it('a hostile second buyer returning on the first buyer’s order makes no capture call', async () => {
    const w = await makeWorld();
    const order = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    w.paypal.approve(order.order_ref);
    await Promise.all(Array.from({ length: 10 }, () => onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: BUYER_B })));
    expect(w.paypal.count('capture')).toBe(0);
    expect((await ent(w)).access_state).toBe('locked');
  });

  it('mismatched custom_id plus a later matching read never unlocks a frozen order', async () => {
    const w = await makeWorld();
    w.paypal.tamper = { custom_id: 'ord_other' };
    const first = await buy(w, BUYER_A, 'tide-tables');
    w.paypal.tamper = {};
    w.td.clock.advance(60_000);
    await onBuyerReturn(w.deps, { order_ref: first.order_ref, actor: BUYER_A });
    expect((await ent(w)).access_state).toBe('locked');
    expect(await n(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
  });

  it('one buyer cannot hold the same article twice: a second purchase of an owned item is refused before any PayPal call', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    const creates = w.paypal.count('create');
    await expect(placeAndCheckout(w, BUYER_A, 'tide-tables')).rejects.toThrow();
    expect(w.paypal.count('create')).toBe(creates);
    expect(await n(w, 'SELECT count(*) AS c FROM orders')).toBe(1);
  });
});
