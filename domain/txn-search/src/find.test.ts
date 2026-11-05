// INT-SR1 (SR1.4): operator quick-find. One query over the unique columns (order ref, last 6 of it, PayPal
// order id, capture id, refund id, receipt id); every exact hit is returned, so one id that sits in two
// columns shows both. Then a name match with SR0's `%` and `_` escaping. Groups: Orders, Sellers, Offers,
// Keys, and Buyers only for an operator with MFA. Top 5 per group. Real (PGlite) database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { TxnSearchError, quickFind } from './index';
import {
  NOW,
  T0,
  openMigrated,
  seedBuyer,
  seedOrder,
  seedReceipt,
  seedRefund,
  seedStandardWorld,
} from './test-fixtures';
import type { Db } from './test-fixtures';

const MFA: Actor = { kind: 'operator', operator_id: 'op_1', mfa: true };
const NO_MFA: Actor = { kind: 'operator', operator_id: 'op_1', mfa: false };
const SHARED = 'SHARED0123456789AB'; // 18 characters; a provider order id of one order, a capture id of another

let db: Db;
beforeAll(async () => {
  db = await openMigrated();
  await seedStandardWorld(db);
  await seedOrder(db, {
    id: 'order_abcdef',
    buyer: 'b1',
    created_at: '2026-11-04T09:00:00.000Z',
    status: 'paid',
    provider_orders: [{ id: 'po_x', provider_order_id: SHARED }],
    units: [
      {
        id: 'ux',
        publisher: 'p1',
        amount_minor: 100,
        status: 'captured_verified',
        articles: ['a1'],
        capture_id: 'CAPTURE_X_000000001',
      },
    ],
  });
  await seedOrder(db, {
    id: 'order_other',
    buyer: 'b2',
    created_at: '2026-11-04T09:30:00.000Z',
    status: 'paid',
    units: [
      {
        id: 'uy',
        publisher: 'p2',
        amount_minor: 200,
        status: 'captured_verified',
        articles: ['a2'],
        capture_id: SHARED,
      },
    ],
  });
  await seedRefund(db, {
    id: 'rf1',
    unit: 'ux',
    state: 'sent',
    created_at: T0,
    refund_id: 'REFUND_X_00000000001',
  });
  await seedReceipt(db, 'rcpt_ux_0001', 'order_abcdef');
  await db.query(
    `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, created_at, updated_at)
     VALUES ('ofr_harbour', 'v1', 'p1', 'a1', 'authorised', 'USD', '[]'::jsonb, '{}'::jsonb, 't1', '{}'::jsonb, $1, $1, $1)`,
    [T0],
  );
});
afterAll(async () => {
  await db.close();
});

const refs = (r: { orders: { order_ref: string }[] }): string[] =>
  r.orders.map((o) => o.order_ref).sort();
const find = (p: Actor, q: string) => quickFind(db, p, q, { now: NOW });

describe('SR1.4 quick-find ids', () => {
  it.each([
    ['order ref', 'ref_order_abcdef', 'order_ref'],
    ['short ref (last 6)', 'abcdef', 'order_ref6'],
    ['capture id', 'CAPTURE_X_000000001', 'capture_id'],
    ['refund id', 'REFUND_X_00000000001', 'refund_id'],
    ['receipt id', 'rcpt_ux_0001', 'receipt_id'],
  ])('%s lands in Orders', async (_name, q, column) => {
    const r = await find(MFA, q);
    expect(refs(r)).toEqual(['ref_order_abcdef']);
    expect(r.orders[0]!.matched).toBe(column);
  });

  it('a PayPal order id lands in Orders', async () => {
    const r = await find(MFA, 'PAYPAL000001');
    expect(r.orders.length).toBeLessThanOrEqual(5);
    const own = await find(MFA, SHARED);
    expect(own.orders.map((o) => o.matched).sort()).toEqual(['capture_id', 'provider_order_id']);
  });

  it('an id that matches two columns of two orders returns both hits', async () => {
    const r = await find(MFA, SHARED);
    expect(refs(r)).toEqual(['ref_order_abcdef', 'ref_order_other']);
    const byRef = Object.fromEntries(r.orders.map((o) => [o.order_ref, o.matched]));
    expect(byRef).toEqual({ ref_order_abcdef: 'provider_order_id', ref_order_other: 'capture_id' });
  });

  it('an unknown id finds nothing', async () => {
    const r = await find(MFA, 'NOPE_NOT_AN_ID');
    expect(r.orders).toEqual([]);
    expect(r.sellers).toEqual([]);
    expect(r.offers).toEqual([]);
    expect(r.keys).toEqual([]);
  });
});

describe('SR1.4 quick-find names and groups', () => {
  it('a seller name lands in Sellers, an article title in Offers, a key id in Keys', async () => {
    const sellers = await find(MFA, 'harbour');
    expect(sellers.sellers.map((s) => s.publisher_id)).toEqual(['p1']);
    expect(sellers.sellers[0]!.display_name).toBe('Harbour Markets');
    expect(sellers.offers.map((o) => o.offer_id)).toEqual(['ofr_harbour']);
    const keys = await find(MFA, 'key_b2');
    expect(keys.keys.map((k) => k.key_id)).toEqual(['key_b2']);
  });

  it('Buyers appear only with MFA', async () => {
    const withMfa = await find(MFA, 'Ada');
    expect(withMfa.buyers?.map((b) => b.buyer_id)).toEqual(['b1']);
    const without = await find(NO_MFA, 'Ada');
    expect(without.buyers).toBeUndefined();
    expect(JSON.stringify(without)).not.toContain('Ada Buyer');
  });

  it('without MFA a name is not matched and not shown; an exact slug or id still works', async () => {
    const byName = await find(NO_MFA, 'Harbour Markets');
    expect(byName.sellers).toEqual([]);
    const bySlug = await find(NO_MFA, 'harbour');
    expect(bySlug.sellers.map((s) => s.publisher_id)).toEqual(['p1']);
    expect(bySlug.sellers[0]).not.toHaveProperty('display_name');
  });

  it('% and _ are literal, and a query over 100 characters or empty finds nothing', async () => {
    for (const q of ['%', '_', '%%', 'h_rbour']) {
      const r = await find(MFA, q);
      expect(r.sellers).toEqual([]);
      expect(r.buyers).toEqual([]);
    }
    for (const q of ['', '   ', 'a'.repeat(101)]) {
      const r = await find(MFA, q);
      expect(r.orders).toEqual([]);
      expect(r.sellers).toEqual([]);
    }
  });

  it('shows at most 5 per group', async () => {
    for (let i = 0; i < 7; i++) await seedBuyer(db, `bz${String(i)}`, `Zed Buyer ${String(i)}`);
    const r = await find(MFA, 'Zed Buyer');
    expect(r.buyers).toHaveLength(5);
  });

  it('only an operator may ask', async () => {
    await expect(find({ kind: 'buyer', buyer_id: 'b1' }, 'x')).rejects.toBeInstanceOf(
      TxnSearchError,
    );
    await expect(find({ kind: 'publisher', publisher_id: 'p1' }, 'x')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
