// MVP-A acceptance A-18 and A-19: time lost to a failed delivery is restored free and creates no
// order or ledger entry; after the window ends the item stays listed with its receipt and the
// right words. Expected results are the text of docs/design/mvp-plan.md. Offline only.
import { recordDeliveryEvent, sweepWindows } from '@umsbx/access-clock';
import { issueLink } from '@umsbx/delivery';
import { getLibrary } from '@umsbx/library';
import { getReceiptForBuyer, renderReceiptHtml } from '@umsbx/receipts';
import { describe, expect, it } from 'vitest';
import { BUYER_A, DAY, HOUR, buy, makeWorld, one } from './world';

const windowOf = (w: Awaited<ReturnType<typeof makeWorld>>) =>
  one<{ id: string; state: string; started_at: Date; ends_at: Date }>(
    w,
    `SELECT e.id, a.state, a.started_at, a.ends_at FROM entitlements e
       JOIN access_windows a ON a.entitlement_id = e.id ORDER BY e.created_at LIMIT 1`,
  );
const count = async (w: Awaited<ReturnType<typeof makeWorld>>, sql: string) =>
  Number((await one<{ c: string | number }>(w, sql)).c);

describe('A-18 lost_time_restored_free', () => {
  it('delivery fails on day 1 for 6 hours, then succeeds: ends_at moves 6 hours later and the new link creates no order or ledger entry', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    const before = await windowOf(w);
    expect(before.state).toBe('running');
    const orders = await count(w, 'SELECT count(*) AS c FROM orders');
    const ledger = await count(w, 'SELECT count(*) AS c FROM ledger_entries');

    w.td.clock.advance(HOUR);
    await recordDeliveryEvent(w.td, {
      entitlement_id: before.id,
      kind: 'delivery_failed',
      link_id: null,
      source: 'system',
      evidence: { reason: 'store_unavailable' },
    });
    w.td.clock.advance(6 * HOUR);
    await recordDeliveryEvent(w.td, {
      entitlement_id: before.id,
      kind: 'delivery_restored',
      link_id: null,
      source: 'system',
      evidence: {},
    });

    const after = await windowOf(w);
    expect(new Date(after.ends_at).getTime() - new Date(before.ends_at).getTime()).toBe(6 * HOUR);
    expect(new Date(after.started_at).getTime()).toBe(new Date(before.started_at).getTime());

    const link = await issueLink(w.deps, { entitlement_id: before.id, actor: BUYER_A });
    expect(link.ok).toBe(true);
    expect(await count(w, 'SELECT count(*) AS c FROM orders')).toBe(orders);
    expect(await count(w, 'SELECT count(*) AS c FROM ledger_entries')).toBe(ledger);
    expect(w.paypal.count('create')).toBe(1);
    expect(w.paypal.count('capture')).toBe(1);
  });

  it('a buyer-sourced failure signal never pauses the clock', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    const before = await windowOf(w);
    w.td.clock.advance(HOUR);
    await recordDeliveryEvent(w.td, {
      entitlement_id: before.id,
      kind: 'delivery_failed',
      link_id: null,
      source: 'buyer',
      evidence: {},
    });
    w.td.clock.advance(6 * HOUR);
    await recordDeliveryEvent(w.td, {
      entitlement_id: before.id,
      kind: 'delivery_restored',
      link_id: null,
      source: 'buyer',
      evidence: {},
    });
    const after = await windowOf(w);
    expect(new Date(after.ends_at).getTime()).toBe(new Date(before.ends_at).getTime());
  });
});

describe('A-19 history_stays', () => {
  it('after ends_at the keep item says Retrieval closed, the online item says Reading ended, both stay listed with receipts', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables', 'keep_retrieve');
    await buy(w, BUYER_A, 'ferry-timetables', 'online_read');
    w.td.clock.advance(5 * DAY + HOUR);
    await sweepWindows(w.td, { max_items: 50 });
    const lib = await getLibrary(w.td.db, { buyer_id: 'buy_A', now: w.td.clock.now() });
    expect(lib).toHaveLength(2);
    const keep = lib.find((i) => i.option === 'keep_retrieve');
    const online = lib.find((i) => i.option === 'online_read');
    expect(keep?.status_text).toBe('Retrieval closed, your copy is yours');
    expect(online?.status_text).toBe('Reading ended');
    expect(keep?.can_open).toBe(false);
    expect(online?.can_open).toBe(false);
    for (const item of lib) {
      expect(item.receipt_versions.length).toBeGreaterThanOrEqual(1);
    }
    const orders = await w.td.db.query<{ id: string }>('SELECT id FROM orders ORDER BY created_at');
    for (const o of orders.rows) {
      const r = await getReceiptForBuyer(w.td.db, { order_id: o.id, buyer_id: 'buy_A' });
      expect(r).not.toBeNull();
    }
  });
});

describe('A-22 labels_from_data (receipts and library)', () => {
  it('every receipt and library item shows the label derived from the stored environment', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    const o = await one<{ id: string; environment: string }>(
      w,
      'SELECT id, environment FROM orders LIMIT 1',
    );
    expect(o.environment).toBe('dryrun');
    const receipt = await getReceiptForBuyer(w.td.db, { order_id: o.id, buyer_id: 'buy_A' });
    expect(receipt?.environment).toBe('dryrun');
    expect(renderReceiptHtml(receipt!)).toContain('Dry run');
    expect(renderReceiptHtml(receipt!)).not.toMatch(/\bSandbox\b/);
    const lib = await getLibrary(w.td.db, { buyer_id: 'buy_A', now: w.td.clock.now() });
    expect(lib.every((i) => i.environment === 'dryrun')).toBe(true);
  });

  it('a receipt whose stored environment is sandbox shows Sandbox, and a contradicting label throws', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    const o = await one<{ id: string }>(w, 'SELECT id FROM orders LIMIT 1');
    const receipt = await getReceiptForBuyer(w.td.db, { order_id: o.id, buyer_id: 'buy_A' });
    const asSandbox = { ...receipt!, environment: 'sandbox' as const };
    expect(renderReceiptHtml(asSandbox)).toContain('Sandbox');
    expect(() => renderReceiptHtml(asSandbox, 'Dry run')).toThrow();
  });
});
