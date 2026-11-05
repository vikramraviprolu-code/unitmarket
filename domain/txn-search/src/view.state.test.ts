// INT-SR0 (SR0.4): the txn_rows view. One row per order unit; each column computed as the spec says; the
// reference match reads order ref, short ref, PayPal order id, capture id, refund id and receipt id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTxnQuery } from '@umsbx/contracts';
import type { Actor } from '@umsbx/contracts';
import { scopeQuery, searchTransactions } from './index';
import {
  NOW,
  openMigrated,
  seedAlert,
  seedArticle,
  seedBuyer,
  seedCase,
  seedOrder,
  seedPublisher,
  seedReceipt,
  seedRefund,
  seedStandardWorld,
  seedUnknownOperation,
} from './test-fixtures';
import type { Db } from './test-fixtures';

const EXPECTED_COLUMNS = [
  'unit_id',
  'order_id',
  'order_ref',
  'order_ref6',
  'order_status',
  'order_mismatch',
  'unit_status',
  'unit_updated_at',
  'created_at',
  'captured_verified_at',
  'currency',
  'amount_minor',
  'order_total_minor',
  'refunded_minor',
  'environment',
  'publisher_id',
  'seller_name',
  'seller_slug',
  'provider_order_id',
  'capture_id',
  'buyer_id',
  'buyer_display_name',
  'titles',
  'refund_state',
  'refund_id',
  'refund_amount_minor',
  'case_state',
  'case_kind',
  'alert_count',
  'has_unknown_op',
  'channel',
  'agent_key_id',
  'mandate_id',
];

const OPERATOR: Actor = { kind: 'operator', operator_id: 'op_1', mfa: true };

let db: Db;
beforeAll(async () => {
  db = await openMigrated();
  await seedStandardWorld(db);
  // A split order (two sellers, two PayPal orders) and a unit with no entitlement.
  await seedOrder(db, {
    id: 'o6',
    buyer: 'b1',
    created_at: '2026-11-04T09:00:00.000Z',
    status: 'paid',
    provider_orders: [
      { id: 'po_o6_1', provider_order_id: 'SPLITONEAAA', publisher: 'p1' },
      { id: 'po_o6_2', provider_order_id: 'SPLITTWOBBB', publisher: 'p2' },
    ],
    units: [
      {
        id: 'u6a',
        publisher: 'p1',
        amount_minor: 100,
        status: 'captured_verified',
        articles: ['a1'],
      },
      { id: 'u6b', publisher: 'p2', amount_minor: 200, status: 'captured_verified', articles: [] },
    ],
  });
  // An order whose reference is longer than six characters, to tell the short reference from the full one.
  await seedOrder(db, {
    id: 'order_long_name_7',
    buyer: 'b1',
    created_at: '2026-11-04T08:00:00.000Z',
    status: 'created',
    units: [{ id: 'u_long', publisher: 'p1', amount_minor: 5, status: 'expected' }],
  });
  // Refunds and cases on u1: the latest by (created_at, id) must win.
  await seedRefund(db, {
    id: 'rf_a',
    unit: 'u1',
    state: 'failed',
    created_at: '2026-11-02T10:00:00.000Z',
  });
  await seedRefund(db, {
    id: 'rf_b',
    unit: 'u1',
    state: 'requested',
    created_at: '2026-11-02T10:00:00.000Z',
    refund_id: 'REFUNDB123',
    amount_minor: 200,
  });
  await seedRefund(db, {
    id: 'rf_z',
    unit: 'u1',
    state: 'rejected',
    created_at: '2026-11-01T10:00:00.000Z',
  });
  await seedCase(db, {
    id: 'cas_a',
    order: 'o1',
    buyer: 'b1',
    kind: 'delivery_failed',
    state: 'closed',
    created_at: '2026-11-02T10:00:00.000Z',
  });
  await seedCase(db, {
    id: 'cas_b',
    order: 'o1',
    buyer: 'b1',
    kind: 'refund_requested',
    state: 'open',
    created_at: '2026-11-03T10:00:00.000Z',
  });
  await seedAlert(db, {
    id: 'alr_1',
    order: 'o4',
    unit: 'u4',
    kind: 'capture_pending',
    reason: 'a',
  });
  await seedAlert(db, { id: 'alr_2', order: 'o4', kind: 'frozen', reason: 'b' });
  await seedUnknownOperation(db, { id: 'opr_1', order: 'o4', unit: 'u4' });
  await seedReceipt(db, 'rct_o2', 'o2');
  // Make sure a buyer, a seller and an article exist that no order uses.
  await seedBuyer(db, 'b9', 'Idle Buyer');
  await seedPublisher(db, 'p9', 'idle', 'Idle Seller');
  await seedArticle(db, 'a9', 'p9', 'Idle Article');
});
afterAll(() => db.close());

const row = async (unit: string): Promise<Record<string, unknown>> => {
  const r = await db.query<Record<string, unknown>>('SELECT * FROM txn_rows WHERE unit_id = $1', [
    unit,
  ]);
  expect(r.rows, unit).toHaveLength(1);
  return r.rows[0]!;
};

const find = async (ref: string): Promise<string[]> => {
  const raw = { ref };
  const page = await searchTransactions(db, scopeQuery(OPERATOR, raw, parseTxnQuery(raw)), {
    now: NOW,
    h: 'h',
  });
  return page.rows.map((r) => String(r['unit_id'])).sort();
};

describe('txn_rows shape (SR0.4)', () => {
  it('has exactly the columns of the spec', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'txn_rows'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual([...EXPECTED_COLUMNS].sort());
  });

  it('has one row per order unit', async () => {
    const units = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM order_units'))
      .rows[0]!.n;
    const rows = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM txn_rows')).rows[0]!
      .n;
    expect(units).toBe(7);
    expect(rows).toBe(units);
    const distinct = (
      await db.query<{ n: number }>('SELECT count(DISTINCT unit_id)::int AS n FROM txn_rows')
    ).rows[0]!.n;
    expect(distinct).toBe(units);
  });

  it('copies order, unit, seller and buyer fields', async () => {
    const r = await row('u2');
    expect(r).toMatchObject({
      unit_id: 'u2',
      order_id: 'o2',
      order_ref: 'ref_o2',
      order_ref6: 'ref_o2',
      order_status: 'paid',
      order_mismatch: false,
      unit_status: 'captured_verified',
      currency: 'USD',
      amount_minor: 1200,
      order_total_minor: 1200,
      refunded_minor: 0,
      environment: 'dryrun',
      publisher_id: 'p2',
      seller_name: 'Pine Press',
      seller_slug: 'pine',
      capture_id: 'CAP_u2',
      buyer_id: 'b1',
      buyer_display_name: 'Ada Buyer',
    });
    expect(new Date(String(r['created_at'])).toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(new Date(String(r['captured_verified_at'])).toISOString()).toBe(
      '2026-11-02T10:00:00.000Z',
    );
  });

  it('order_ref6 is the last six characters of the order reference', async () => {
    expect((await row('u_long'))['order_ref']).toBe('ref_order_long_name_7');
    expect((await row('u_long'))['order_ref6']).toBe('name_7');
  });
});

describe('titles (SR0.4)', () => {
  it('a unit with two articles has two titles, in title order', async () => {
    expect((await row('u2'))['titles']).toEqual(['Pine Extra', 'Pine Weekly']);
  });
  it('a unit with no entitlement has an empty list, and the row is still there', async () => {
    expect((await row('u6b'))['titles']).toEqual([]);
  });
});

describe('provider order id (SR0.4, R2-1)', () => {
  it('is filled for a single-route order, where the provider order has no publisher', async () => {
    const r = await row('u1');
    expect(String(r['provider_order_id'])).toMatch(/^PAYPAL\d{6}$/);
    const po = await db.query<{ publisher_id: string | null; route: string }>(
      `SELECT publisher_id, route FROM provider_orders WHERE order_id = 'o1'`,
    );
    expect(po.rows).toEqual([{ publisher_id: null, route: 'single' }]);
  });
  it('is filled for each line of a split order, each from its own provider order', async () => {
    expect((await row('u6a'))['provider_order_id']).toBe('SPLITONEAAA');
    expect((await row('u6b'))['provider_order_id']).toBe('SPLITTWOBBB');
  });
  it('ref=<PayPal order id> finds the single-route line and the split line', async () => {
    const single = String((await row('u3'))['provider_order_id']);
    expect(await find(single)).toEqual(['u3']);
    expect(await find('SPLITONEAAA')).toEqual(['u6a']);
    expect(await find('SPLITTWOBBB')).toEqual(['u6b']);
  });
});

describe('reference match (SR0.4)', () => {
  it('matches the order reference (every line of the order) and the short reference', async () => {
    expect(await find('ref_o6')).toEqual(['u6a', 'u6b']);
    expect(await find('ref_order_long_name_7')).toEqual(['u_long']);
    expect(await find('name_7')).toEqual(['u_long']);
    expect(await find('ame_7')).toEqual([]); // exact, not a substring
  });
  it('matches the capture id', async () => {
    expect(await find('CAP_u4')).toEqual([]); // pending: no capture
    expect(await find('CAP_u2')).toEqual(['u2']);
  });
  it('matches a refund id of the order (the whole order is found)', async () => {
    expect(await find('REFUNDB123')).toEqual(['u1']);
  });
  it('matches a receipt id of the order', async () => {
    expect(await find('rct_o2')).toEqual(['u2']);
  });
  it('matches nothing for an unknown reference', async () => {
    expect(await find('NOSUCHREF')).toEqual([]);
  });
});

describe('latest refund and case win by (created_at, id) (SR0.4)', () => {
  it('the refund with the latest time, and the highest id on a tie, is shown', async () => {
    const r = await row('u1');
    expect(r['refund_state']).toBe('requested');
    expect(r['refund_id']).toBe('REFUNDB123');
    expect(r['refund_amount_minor']).toBe(200);
  });
  it('a line with no refund has nulls', async () => {
    const r = await row('u3');
    expect(r['refund_state']).toBeNull();
    expect(r['refund_id']).toBeNull();
    expect(r['refund_amount_minor']).toBeNull();
  });
  it('the latest case of the order is shown, on every line of the order', async () => {
    const r = await row('u1');
    expect(r['case_state']).toBe('open');
    expect(r['case_kind']).toBe('refund_requested');
    expect((await row('u2'))['case_state']).toBeNull();
  });
});

describe('alerts, unknown operations and channel (SR0.4)', () => {
  it('alert_count counts the alerts of the order', async () => {
    expect((await row('u4'))['alert_count']).toBe(2);
    expect((await row('u1'))['alert_count']).toBe(0);
  });
  it('has_unknown_op is true only with an operation in state unknown', async () => {
    expect((await row('u4'))['has_unknown_op']).toBe(true);
    expect((await row('u1'))['has_unknown_op']).toBe(false);
  });
  it('an agent buy has channel agent, its key and its mandate; others are human with nulls', async () => {
    expect(await row('u3')).toMatchObject({
      channel: 'agent',
      agent_key_id: 'key_b2',
      mandate_id: 'man_b2',
    });
    expect(await row('u1')).toMatchObject({
      channel: 'human',
      agent_key_id: null,
      mandate_id: null,
    });
  });
});

describe('the view is read-only and reads through the caller (SR0.4)', () => {
  it('refuses a write', async () => {
    await expect(db.query(`UPDATE txn_rows SET order_status = 'paid'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM txn_rows`)).rejects.toThrow();
  });
  it('is created with security_invoker', async () => {
    const r = await db.query<{ reloptions: string[] | null }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'txn_rows' AND relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows[0]!.reloptions).toContain('security_invoker=true');
  });
});
