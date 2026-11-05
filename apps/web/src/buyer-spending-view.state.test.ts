// INT-BUY / BUY.4: the Spending page. The buyer sees its own purchases with the shared filter bar (buyer fields
// only). The list comes from SR1's buyer read (composition/buyer.ts); the model in lib/buyer-spending-view.ts
// turns lines into rows in words. The CSV export is attacked in buyer-export.adversarial.test.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, seedSales } from './search-support';
import type { SearchRig } from './search-support';
import { barState, fieldControls } from './lib/filter-bar-view';
import { SPENDING_EMPTY, SPENDING_FILTER_CONTEXT, spendingModel } from './lib/buyer-spending-view';
import { readSpending } from './composition/buyer';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

type Buyer = Extract<Actor, { kind: 'buyer' }>;
let rig: SearchRig;
let A: Buyer;
let B: Buyer;
const NOW = new Date('2026-11-05T12:00:00.000Z');

beforeAll(async () => {
  rig = await bootSearch();
  A = rig.buyerA as Buyer;
  B = rig.buyerB as Buyer;
  const harbour = (rig.harbour as Extract<Actor, { kind: 'publisher' }>).publisher_id;
  const from = new Date(rig.now.getTime() - 5 * 86_400_000);
  await seedSales(rig.app.db, {
    buyer_id: A.buyer_id,
    publisher_id: harbour,
    count: 6,
    from,
    prefix: 'spa',
  });
  await seedSales(rig.app.db, {
    buyer_id: A.buyer_id,
    publisher_id: harbour,
    count: 2,
    from: new Date(from.getTime() + 3_600_000),
    prefix: 'spr',
    status: 'refunded',
  });
  await seedSales(rig.app.db, {
    buyer_id: B.buyer_id,
    publisher_id: harbour,
    count: 3,
    from,
    prefix: 'spb',
  });
}, 120_000);

describe('BUY.4 the list', () => {
  it("holds the buyer's own purchases only", async () => {
    const mine = await readSpending(A.buyer_id, {});
    expect(mine.lines).toHaveLength(8);
    expect(mine.lines.every((l) => /^sp[ar]/.test(l.order_ref))).toBe(true);
    const theirs = await readSpending(B.buyer_id, {});
    expect(theirs.lines).toHaveLength(3);
    expect(theirs.lines.every((l) => l.order_ref.startsWith('spb'))).toBe(true);
  });

  it('a status filter narrows it, and a bad value is dropped, not an error', async () => {
    const refunded = await readSpending(A.buyer_id, { status: 'refunded' });
    expect(refunded.lines).toHaveLength(2);
    expect(refunded.lines.every((l) => l.status === 'refunded')).toBe(true);
    const bad = await readSpending(A.buyer_id, { status: 'not-a-status' });
    expect(bad.lines.length).toBeGreaterThan(0);
  });

  it('a seller-only key such as buyer= is refused with field_not_allowed', async () => {
    await expect(readSpending(A.buyer_id, { buyer: B.buyer_id })).rejects.toMatchObject({
      code: 'field_not_allowed',
    });
  });

  it('pages with a cursor and never repeats a line', async () => {
    const one = await readSpending(A.buyer_id, { limit: '5' });
    expect(one.lines).toHaveLength(5);
    expect(one.next_cursor).not.toBeNull();
    const two = await readSpending(A.buyer_id, { limit: '5', cursor: one.next_cursor! });
    const refs = [...one.lines, ...two.lines].map((l) => l.order_ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toHaveLength(8);
  });
});

describe('BUY.4 the model', () => {
  it('turns lines into rows with the order link, items, money, status word and who bought', async () => {
    const { lines: ls } = await readSpending(A.buyer_id, { status: 'refunded' });
    const m = spendingModel(ls, NOW);
    expect(m.empty).toBeNull();
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toMatchObject({
      href: `/orders/${ls[0]!.order_ref}`,
      status_word: 'Refunded',
      by: 'You',
    });
    expect(m.rows[0]!.money_text).toMatch(/^\$\d+\.\d\d$/);
  });
  it('no lines gives words, not a blank', () => {
    expect(spendingModel([], NOW)).toMatchObject({ rows: [], empty: SPENDING_EMPTY });
  });
  it('the filter bar is the buyer one: its fields leave out buyer and seller', () => {
    expect(SPENDING_FILTER_CONTEXT).toEqual({ kind: 'txn', persona: 'buyer' });
    const fields = fieldControls(SPENDING_FILTER_CONTEXT).map((c) => c.field);
    expect(fields).toContain('status');
    expect(fields).not.toContain('buyer');
    expect(barState(SPENDING_FILTER_CONTEXT, { status: 'paid', buyer: 'x' }).map).toEqual({
      status: 'paid',
    });
  });
});
