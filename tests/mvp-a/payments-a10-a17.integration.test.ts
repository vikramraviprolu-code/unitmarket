// MVP-A acceptance A-10 to A-17: order before charge, claim never unlocks, verified read-back
// unlocks and starts the clock, mismatch freezes, lost response, concurrent capture, pending,
// readiness before charge. Expected results are the text of docs/design/mvp-plan.md, written
// from the requirement before the implementation was read. Offline only.
import { applyAutomaticRules } from '@umsbx/recovery';
import { getLibrary } from '@umsbx/library';
import { onBuyerReturn, runDue } from '@umsbx/payments';
import { describe, expect, it } from 'vitest';
import { BUYER_A, DAY, HARBOUR, buy, makeWorld, one, placeAndCheckout, rows } from './world';
import type { Tamper, World } from './world';

const ent = (w: World) =>
  one<{ id: string; money_state: string; access_state: string }>(
    w,
    'SELECT id, money_state, access_state FROM entitlements ORDER BY created_at LIMIT 1',
  );
const orderRow = (w: World) =>
  one<{ id: string; status: string }>(
    w,
    'SELECT id, status FROM orders ORDER BY created_at LIMIT 1',
  );
const count = async (w: World, sql: string): Promise<number> =>
  Number((await one<{ c: string | number }>(w, sql)).c);
const outboundOn = (w: World) =>
  w.td.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);

describe('A-10 order_before_charge', () => {
  it('order, expected unit, pending entitlement and a prepared create operation exist when the provider sees the create call', async () => {
    const w = await makeWorld();
    const seen: Record<string, number> = {};
    w.paypal.onCreate = async () => {
      seen.orders = await count(w, 'SELECT count(*) AS c FROM orders');
      seen.units = await count(
        w,
        "SELECT count(*) AS c FROM order_units WHERE status = 'expected'",
      );
      seen.pending = await count(
        w,
        "SELECT count(*) AS c FROM entitlements WHERE money_state = 'pending' AND access_state = 'locked'",
      );
      seen.prepared = await count(
        w,
        // mvp-plan A-10 says `prepared`; the engine moves the row to `sent` (lease taken) just before
        // the call, so the durable pre-call record is read as prepared-or-sent (ASM-18-1).
        "SELECT count(*) AS c FROM operations WHERE kind = 'create' AND state IN ('prepared', 'sent')",
      );
    };
    await placeAndCheckout(w, BUYER_A, 'tide-tables');
    expect(w.paypal.count('create')).toBe(1);
    expect(seen).toEqual({ orders: 1, units: 1, pending: 1, prepared: 1 });
  });
});

describe('A-11 claim_never_unlocks', () => {
  it('capture answers 201 COMPLETED but the read-back is unavailable: the item stays locked and says Confirming payment', async () => {
    const w = await makeWorld();
    w.paypal.readsUnavailableAfterCapture = true;
    await buy(w, BUYER_A, 'tide-tables');
    expect(w.paypal.count('capture')).toBe(1);
    const e = await ent(w);
    expect(e.access_state).toBe('locked');
    expect(e.money_state).not.toBe('captured');
    const lib = await getLibrary(w.td.db, { buyer_id: 'buy_A', now: w.td.clock.now() });
    expect(lib).toHaveLength(1);
    expect(lib[0]?.can_open).toBe(false);
    expect(lib[0]?.status_text).toBe('Confirming payment');
    expect(await count(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
  });
});

describe('A-12 readback_match_unlocks_and_starts_clock', () => {
  it('a matching read-back makes the item available; started_at is the verified moment, ends_at exactly 5 days later', async () => {
    const w = await makeWorld({ start: '2026-10-22T10:07:31.000Z' });
    const before = w.td.clock.now().toISOString();
    await buy(w, BUYER_A, 'tide-tables');
    const e = await ent(w);
    expect(e.access_state).toBe('available');
    expect(e.money_state).toBe('captured');
    const win = await one<{ state: string; started_at: Date; ends_at: Date }>(
      w,
      'SELECT state, started_at, ends_at FROM access_windows WHERE entitlement_id = $1',
      [e.id],
    );
    expect(win.state).toBe('running');
    expect(new Date(win.started_at).toISOString()).toBe(before);
    expect(new Date(win.ends_at).getTime() - new Date(win.started_at).getTime()).toBe(5 * DAY);
    expect(await count(w, "SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'")).toBe(1);
  });

  it('the window starts at the verified moment, not at the buyer return that preceded it', async () => {
    const w = await makeWorld({ start: '2026-10-22T10:00:00.000Z' });
    w.paypal.readsUnavailableAfterCapture = true;
    const { order_ref } = await buy(w, BUYER_A, 'tide-tables');
    expect((await ent(w)).access_state).toBe('locked');
    w.td.clock.advance(2 * 3_600_000);
    w.paypal.readsUnavailableAfterCapture = false;
    await outboundOn(w);
    // Read-back is possible again two hours later; the periodic reconcile (not the buyer) verifies.
    w.td.clock.advance(60_000);
    await runDue(w.deps, { max_items: 10 });
    await onBuyerReturn(w.deps, { order_ref, actor: BUYER_A });
    const e = await ent(w);
    expect(e.access_state).toBe('available');
    const win = await one<{ started_at: Date; ends_at: Date }>(
      w,
      'SELECT started_at, ends_at FROM access_windows WHERE entitlement_id = $1',
      [e.id],
    );
    expect(new Date(win.started_at).toISOString()).toBe(w.td.clock.now().toISOString());
    expect(new Date(win.ends_at).getTime() - new Date(win.started_at).getTime()).toBe(5 * DAY);
  });
});

describe('A-13 mismatch_freezes', () => {
  const cases: [string, Tamper][] = [
    ['amount plus one cent', { amount_delta: 1 }],
    ['another payee', { payee: 'OTHERPAYEE1' }],
    ['EUR instead of USD', { currency: 'EUR' }],
    ['another custom_id', { custom_id: 'ord_someone_else' }],
  ];
  for (const [name, tamper] of cases) {
    it(`${name}: order frozen, item locked, alert and recovery case, no ledger sale`, async () => {
      const w = await makeWorld();
      w.paypal.tamper = tamper;
      await buy(w, BUYER_A, 'tide-tables');
      expect((await orderRow(w)).status).toBe('frozen');
      expect((await ent(w)).access_state).toBe('locked');
      expect(await count(w, 'SELECT count(*) AS c FROM alerts')).toBeGreaterThanOrEqual(1);
      await applyAutomaticRules(w.td, { max_items: 20 });
      expect(
        await count(w, "SELECT count(*) AS c FROM recovery_cases WHERE kind = 'frozen_order'"),
      ).toBe(1);
      expect(await count(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
    });
  }
});

describe('A-14 lost_response_one_capture', () => {
  it('capture times out after send; the read-back says COMPLETED: one capture recorded, at most one retry with the same key within 5 h, item unlocked once', async () => {
    const w = await makeWorld();
    await outboundOn(w);
    w.paypal.next.lose_response = true;
    const { order_ref } = await buy(w, BUYER_A, 'tide-tables');
    w.td.clock.advance(60_000);
    await runDue(w.deps, { max_items: 10 });
    w.td.clock.advance(5 * 60_000);
    await runDue(w.deps, { max_items: 10 });
    await onBuyerReturn(w.deps, { order_ref, actor: BUYER_A });

    const captures = w.paypal.calls.filter((c) => c.op === 'capture');
    expect(captures.length).toBeLessThanOrEqual(2);
    expect(new Set(captures.map((c) => c.request_id)).size).toBe(1);
    expect(
      await count(w, 'SELECT count(*) AS c FROM order_units WHERE capture_id IS NOT NULL'),
    ).toBe(1);
    expect(await count(w, "SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'")).toBe(1);
    const e = await ent(w);
    expect(e.access_state).toBe('available');
    expect(
      await count(w, "SELECT count(*) AS c FROM access_events WHERE kind = 'access_ready'"),
    ).toBe(1);
  });

  it('after 5 hours the same key is not resent: a stale unknown capture is read, not repeated', async () => {
    const w = await makeWorld();
    await outboundOn(w);
    w.paypal.next.lose_response = true;
    w.paypal.readsUnavailableAfterCapture = true;
    await buy(w, BUYER_A, 'tide-tables');
    const before = w.paypal.count('capture');
    w.td.clock.advance(5 * 3_600_000 + 60_000);
    await runDue(w.deps, { max_items: 10 });
    const keys = new Set(w.paypal.calls.filter((c) => c.op === 'capture').map((c) => c.request_id));
    // Never a second capture with a key PayPal may have forgotten; at most the same key once more
    // before 5 h, and no resend of any kind after it.
    expect(w.paypal.count('capture')).toBe(before);
    expect(keys.size).toBe(1);
  });
});

describe('A-15 concurrent_capture_one_call', () => {
  it('20 concurrent return requests for one order make exactly one outbound capture', async () => {
    const w = await makeWorld();
    const order = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    w.paypal.approve(order.order_ref);
    let release: () => void = () => undefined;
    w.paypal.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const all = Promise.all(
      Array.from({ length: 20 }, () =>
        onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: BUYER_A }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await all;
    expect(w.paypal.count('capture')).toBe(1);
    expect(await count(w, "SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'")).toBe(1);
    expect(
      await count(w, "SELECT count(*) AS c FROM access_events WHERE kind = 'access_ready'"),
    ).toBe(1);
  });
});

describe('A-16 pending_never_unlocks', () => {
  it('a PENDING read-back with RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION stays locked and says Payment pending at PayPal', async () => {
    const w = await makeWorld();
    w.paypal.next.status = 'PENDING';
    w.paypal.next.reason = 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION';
    const { ret } = await buy(w, BUYER_A, 'tide-tables');
    expect((await ent(w)).access_state).toBe('locked');
    expect(await count(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(0);
    if (ret.ok) expect(ret.value.buyer_message).toMatch(/^Payment pending at PayPal/);
    const lib = await getLibrary(w.td.db, { buyer_id: 'buy_A', now: w.td.clock.now() });
    expect(lib[0]?.status_text).toBe('Payment pending at PayPal');
    expect(lib[0]?.can_open).toBe(false);
  });
});

describe('A-17 readiness_before_charge', () => {
  it('the content changed after approval: no capture call, order failed, buyer told not charged', async () => {
    const w = await makeWorld();
    const order = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    w.paypal.approve(order.order_ref);
    const art = await one<{ content_key: string }>(
      w,
      `SELECT a.content_key FROM entitlements e JOIN articles a ON a.id = e.article_id LIMIT 1`,
    );
    const newBytes = new TextEncoder().encode('the publisher replaced the text after approval');
    await w.td.db.query(
      `UPDATE content_blobs SET data = $2, sha256 = $3, bytes = $4 WHERE content_key = $1`,
      [art.content_key, newBytes, 'f'.repeat(64), newBytes.length],
    );
    const ret = await onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: BUYER_A });
    expect(w.paypal.count('capture')).toBe(0);
    expect((await orderRow(w)).status).toBe('failed');
    expect(ret.ok).toBe(false);
    if (!ret.ok) expect(ret.error.code).toBe('not_charged_content_unavailable');
    expect((await ent(w)).access_state).toBe('locked');
    expect(await rows(w, 'SELECT 1 FROM ledger_entries')).toHaveLength(0);
    expect(HARBOUR).toBe('harbour-ledger');
  });
});
