// INT-SEL / SEL.2 state: the seller sales list. All, Pending and Refunds are views over SR1's seller list
// (keyset paging), and the count of each matches the fixture. The filter bar offers seller fields only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXPECTED, IDS, bootSeller } from './seller-fixture';
import type { SellerRig } from './seller-fixture';

vi.mock('server-only', () => ({}));

let rig: SellerRig;
let seller: typeof import('./composition/seller');
let sv: typeof import('./lib/seller-sales-view');
let bar: typeof import('./lib/filter-bar-view');

beforeAll(async () => {
  rig = await bootSeller();
  seller = await import('./composition/seller');
  sv = await import('./lib/seller-sales-view');
  bar = await import('./lib/filter-bar-view');
}, 120_000);
afterAll(async () => {
  await rig.app.close();
});

describe('the three views', () => {
  it('are All, Pending and Refunds, each a plain query map', () => {
    expect(sv.SALES_TABS).toEqual(['all', 'pending', 'refunds']);
    expect(sv.salesTabQuery('all')).toEqual({});
    expect(sv.salesTabQuery('pending')).toEqual({ status: 'in_progress' });
    expect(sv.salesTabQuery('refunds')).toEqual({ refund: 'partial,full' });
    expect(sv.parseSalesTab(undefined)).toBe('all');
    expect(sv.parseSalesTab('refunds')).toBe('refunds');
    expect(sv.parseSalesTab('nonsense')).toBe('all');
    expect(sv.parseSalesTab(['pending', 'refunds'])).toBe('pending');
  });

  it('counts match the fixture for seller A', async () => {
    const r = await seller.readSellerSales(rig.A, {});
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.counts).toEqual({
      all: EXPECTED.all,
      pending: EXPECTED.pending,
      refunds: EXPECTED.refunds,
    });
  });

  it('each view lists exactly its lines', async () => {
    const all = await seller.readSellerSales(rig.A, {});
    const pending = await seller.readSellerSales(rig.A, sv.salesTabQuery('pending'));
    const refunds = await seller.readSellerSales(rig.A, sv.salesTabQuery('refunds'));
    if (all.kind !== 'ok' || pending.kind !== 'ok' || refunds.kind !== 'ok') throw new Error('ok');
    expect(all.lines.map((l) => l.unit_id).sort()).toEqual(
      [IDS.uA, IDS.uM, IDS.uR, IDS.uP, IDS.uW, IDS.uO].sort(),
    );
    expect(pending.lines.map((l) => l.unit_id)).toEqual([IDS.uP]);
    expect(refunds.lines.map((l) => l.unit_id)).toEqual([IDS.uR]);
  });

  it('seller B sees its own two lines and none of seller A', async () => {
    const r = await seller.readSellerSales(rig.B, {});
    if (r.kind !== 'ok') throw new Error('ok');
    expect(r.lines.map((l) => l.unit_id).sort()).toEqual([IDS.uB, IDS.uB2].sort());
    expect(r.counts.all).toBe(2);
  });

  it('a seller with no sale gets words, not an error', async () => {
    const r = await seller.readSellerSales(rig.C, {});
    if (r.kind !== 'ok') throw new Error('ok');
    expect(r.lines).toEqual([]);
    expect(r.counts).toEqual({ all: 0, pending: 0, refunds: 0 });
    expect(sv.SALES_EMPTY.length).toBeGreaterThan(0);
  });
});

describe('keyset paging', () => {
  it('pages of two walk all six lines once, newest first, with a cursor between them', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await seller.readSellerSales(rig.A, { limit: '2', ...(cursor ? { cursor } : {}) });
      if (r.kind !== 'ok') throw new Error('ok');
      expect(r.lines.length).toBeLessThanOrEqual(2);
      seen.push(...r.lines.map((l) => l.unit_id));
      cursor = r.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(6);
  });

  it('a cursor from another filter is refused', async () => {
    const first = await seller.readSellerSales(rig.A, { limit: '2' });
    if (first.kind !== 'ok') throw new Error('ok');
    const r = await seller.readSellerSales(rig.A, {
      limit: '2',
      refund: 'partial',
      cursor: first.next_cursor!,
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('bad_cursor');
  });
});

describe('seller fields only', () => {
  it('no line carries a buyer, an agent key, a mandate or an order total', async () => {
    const r = await seller.readSellerSales(rig.A, {});
    if (r.kind !== 'ok') throw new Error('ok');
    const text = JSON.stringify(r);
    for (const bad of [
      'buyer_id',
      'buyer_display_name',
      'agent_key_id',
      'mandate_id',
      'order_total_minor',
      'vs_b',
      'CANARY',
      '7773',
    ])
      expect(text, bad).not.toContain(bad);
  });

  it('a refused filter is refused, whatever its value', async () => {
    for (const q of [
      { buyer: 'x' },
      { agent_key: 'x' },
      { seller: 'x' },
      { seller: '' },
      { environment: 'sandbox' },
    ]) {
      const r = await seller.readSellerSales(rig.A, q);
      expect(r.kind, JSON.stringify(q)).toBe('refused');
      if (r.kind === 'refused') expect(r.code).toBe('field_not_allowed');
    }
  });

  it('the filter bar offers no buyer, seller, agent key, environment or flags field', () => {
    const fields = bar.offeredFields({ kind: 'txn', persona: 'publisher' });
    for (const bad of ['buyer', 'seller', 'agent_key', 'environment', 'flags'])
      expect(fields, bad).not.toContain(bad);
    expect(fields).toContain('status');
    expect(fields).toContain('refund');
  });

  it('a session that is not a seller gets forbidden', async () => {
    expect((await seller.readSellerSales(rig.vsBuyer1, {})).kind).toBe('forbidden');
    expect((await seller.readSellerSales(rig.operator, {})).kind).toBe('forbidden');
    expect((await seller.readSellerSales(null, {})).kind).toBe('forbidden');
  });
});
