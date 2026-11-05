// INT-TR1 / TR1.1: the timeline of a seeded order, in time order, in words; the 500 entry cap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wordsFor } from './words';
import { buyerTimeline, opsTimeline } from './index';
import { CTX, as, freshDb, seedWorld, day } from './support';
import type { Db, World } from './support';

let db: Db;
let w: World;
beforeAll(async () => {
  db = await freshDb();
  w = await seedWorld(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe('a paid, downloaded and refunded order', () => {
  it('gives the buyer the expected entries in time order', async () => {
    const t = await buyerTimeline(db, { order_ref: w.order_ref, buyer_id: w.buyer_1 });
    expect(t).not.toBeNull();
    expect(t!.truncated).toBe(false);
    expect(t!.entries.map((e) => e.event_type)).toEqual([
      'orders.created',
      'order_units.created',
      'order_units.created',
      'orders.updated',
      'order_units.updated',
      'order_units.updated',
      'orders.updated',
      'receipts.created',
      'entitlements.created',
      'entitlements.created',
      'entitlements.updated',
      'entitlements.updated',
      'access_events.created',
      'access_events.created',
      'refund_requests.created',
      'refund_requests.updated',
    ]);
    const at = t!.entries.map((e) => e.at);
    expect([...at].sort()).toEqual(at);
    expect(at[0]).toBe('2026-11-04T09:10:00.000Z');
  });

  it('carries state changes, amounts, a verified flag and words that come from words.ts', async () => {
    const t = (await buyerTimeline(db, { order_ref: w.order_ref, buyer_id: w.buyer_1 }))!;
    const paid = t.entries.find((e) => e.event_type === 'orders.updated' && e.state_to === 'paid')!;
    expect(paid.state_from).toBe('awaiting_buyer');
    expect(paid.words_key).toBe('orders.updated:paid');
    expect(wordsFor(paid.words_key)).toMatch(/paid/i);
    expect(paid.actor).toEqual({ kind: 'paypal', label: 'PayPal' });
    expect(paid.channel).toBe('webhook');
    expect(paid.source).toEqual({ table: 'orders', id: 'ord_1' });
    expect(paid.verified).toBe(true);
    const unit = t.entries.find(
      (e) => e.source.id === 'unt_a' && e.state_to === 'captured_verified',
    )!;
    expect(unit.amount_minor).toBe(500);
    const refund = t.entries.at(-1)!;
    expect(refund.state_from).toBe('requested');
    expect(refund.state_to).toBe('completed');
    expect(Object.keys(refund).sort()).toEqual(
      [
        'actor',
        'at',
        'channel',
        'event_type',
        'seq',
        'source',
        'state_from',
        'state_to',
        'verified',
        'words_key',
        'amount_minor',
      ]
        .filter((k) => k in refund)
        .sort(),
    );
  });

  it('gives the operator every event, including the ones a buyer does not see', async () => {
    const t = (await opsTimeline(db, { order_ref: w.order_ref, mfa: false }))!;
    const types = new Set(t.entries.map((e) => e.event_type));
    for (const x of ['provider_orders.created', 'webhook_events.created', 'ledger_entries.created'])
      expect(types.has(x), x).toBe(true);
    expect(t.entries.length).toBeGreaterThan(16);
  });

  it('an unknown order gives null', async () => {
    expect(await opsTimeline(db, { order_ref: 'ref_nope', mfa: true })).toBeNull();
  });
});

describe('the cap', () => {
  it('501 events give 500 entries and truncated: true, and 500 give truncated: false', async () => {
    const d = await freshDb();
    try {
      const w2 = await seedWorld(d);
      const base = (await opsTimeline(d, { order_ref: w2.order_ref, mfa: false }))!.entries.length;
      const need = 501 - base;
      for (let i = 0; i < need + 1; i += 1) {
        const at = day(11, 0, 0, 5);
        await as(d, CTX.operator(true), at).query(
          `UPDATE orders SET total_minor = $1, updated_at = $2 WHERE id = 'ord_1'`,
          [
            1000 + i,
            `2026-11-05T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
          ],
        );
        if (i === need - 2) {
          const t = (await opsTimeline(d, { order_ref: w2.order_ref, mfa: false }))!;
          expect(t.entries.length).toBe(500);
          expect(t.truncated).toBe(false);
        }
      }
      const t = (await opsTimeline(d, { order_ref: w2.order_ref, mfa: false }))!;
      expect(t.entries.length).toBe(500);
      expect(t.truncated).toBe(true);
    } finally {
      await d.close();
    }
  }, 120_000);
});
