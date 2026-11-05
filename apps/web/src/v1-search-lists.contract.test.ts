// INT-SR1 (SR1.1, SR1.2): TxnQuery on GET /api/v1/orders (buyer) and GET /api/v1/seller/sales (seller).
// A call with no query parameters answers what it answered before this lane (the old answer is rebuilt here
// from the tables). `status=paid,refunded` narrows. Any filter, limit or cursor pages by keyset. An `o1`
// cursor handed out by main still pages on a call with no filter.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderListSchema, SellerSalesSchema } from '@umsbx/contracts';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json, seedSales } from './search-support';
import type { Handler, SearchRig } from './search-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

type Item = Record<string, unknown>;
interface Page {
  items: Item[];
  next_cursor: string | null;
}

let rig: SearchRig;
let buyerKey: string;
let sellerKey: string;
let orders: Handler;
let sales: Handler;
const buyerId = () => (rig.buyerA as { buyer_id: string }).buyer_id;
const harbourId = () => (rig.harbour as { publisher_id: string }).publisher_id;

beforeAll(async () => {
  rig = await bootSearch();
  buyerKey = await rig.key(rig.buyerA, ['orders:read']);
  sellerKey = await rig.key(rig.harbour, ['sales:read']);
  orders = (await import('./app/api/v1/orders/route')).GET as Handler;
  sales = (await import('./app/api/v1/seller/sales/route')).GET as Handler;
  const from = new Date(rig.now.getTime() - 10 * 86_400_000);
  // Buyer A: 25 paid lines and 3 refunded lines of the harbour seller.
  await seedSales(rig.app.db, {
    buyer_id: buyerId(),
    publisher_id: harbourId(),
    count: 25,
    from,
    prefix: 'bp',
  });
  await seedSales(rig.app.db, {
    buyer_id: buyerId(),
    publisher_id: harbourId(),
    count: 3,
    from: new Date(from.getTime() + 3_600_000),
    prefix: 'br',
    status: 'refunded',
  });
  // The seller: 120 lines in all (the 28 above and 92 more), so a page of 25 runs 25, 25, 25, 25, 20.
  await seedSales(rig.app.db, {
    buyer_id: (rig.buyerB as { buyer_id: string }).buyer_id,
    publisher_id: harbourId(),
    count: 92,
    from: new Date(from.getTime() + 7_200_000),
    prefix: 'sx',
  });
});

const getOrders = async (qs: string) => {
  const res = await rig.v1(orders, buyerKey, { url: `/api/v1/orders${qs}` });
  return { res, body: await json<Page>(res) };
};
const getSales = async (qs: string, token = sellerKey) => {
  const res = await rig.v1(sales, token, { url: `/api/v1/seller/sales${qs}` });
  return { res, body: await json<Page>(res) };
};

describe('SR1.1 buyer orders', () => {
  it('a call with no parameters equals the old answer: 20 orders, newest first, an o1 cursor', async () => {
    const { res, body } = await getOrders('');
    expect(res.status).toBe(200);
    OrderListSchema.parse(body);
    const old = await rig.app.db.query<Item>(
      `SELECT order_ref, status, environment, currency, total_minor, created_at FROM orders
        WHERE buyer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
      [buyerId()],
    );
    expect(body.items.map((i) => i['order_ref'])).toEqual(old.rows.map((r) => r['order_ref']));
    expect(Object.keys(body.items[0]!).sort()).toEqual([
      'created_at',
      'currency',
      'environment',
      'order_ref',
      'status',
      'total_minor',
    ]);
    expect(body.next_cursor).not.toBeNull();
    expect(Buffer.from(body.next_cursor!, 'base64url').toString().startsWith('o1:')).toBe(true);
  });

  it('an o1 cursor from main still pages on a no-filter call', async () => {
    const first = await getOrders('');
    const second = await getOrders(`?cursor=${first.body.next_cursor!}`);
    expect(second.res.status).toBe(200);
    expect(second.body.items).toHaveLength(8);
    expect(second.body.next_cursor).toBeNull();
    const refs = [...first.body.items, ...second.body.items].map((i) => i['order_ref']);
    expect(new Set(refs).size).toBe(28);
  });

  it('status=paid,refunded narrows; status=refunded narrows further; failed is empty', async () => {
    const both = await getOrders('?status=paid,refunded&limit=100');
    expect(both.res.status).toBe(200);
    expect(both.body.items).toHaveLength(28);
    const refunded = await getOrders('?status=refunded&limit=100');
    expect(refunded.body.items).toHaveLength(3);
    for (const i of refunded.body.items) {
      expect(i['status']).toBe('refunded');
      expect(String(i['order_ref'])).toMatch(/^br\d+$/);
    }
    expect((await getOrders('?status=failed')).body.items).toEqual([]);
  });

  it('a filter pages by keyset: default 25, then the rest, no repeats', async () => {
    const p1 = await getOrders('?status=paid,refunded');
    expect(p1.body.items).toHaveLength(25);
    const p2 = await getOrders(`?status=paid,refunded&cursor=${p1.body.next_cursor!}`);
    expect(p2.body.items).toHaveLength(3);
    expect(p2.body.next_cursor).toBeNull();
  });

  it('other filters: date range, amount, sort', async () => {
    expect((await getOrders('?min_minor=501&limit=100')).body.items).toEqual([]);
    expect((await getOrders('?max_minor=500&limit=100')).body.items).toHaveLength(28);
    expect((await getOrders('?from=2999-01-01')).body.items).toEqual([]);
    const asc = await getOrders('?sort=newest&dir=asc&limit=2');
    expect(asc.body.items.map((i) => i['order_ref'])).toEqual(['bp000', 'bp001']);
  });

  it('a buyer sees only its own lines', async () => {
    const { body } = await getOrders(
      '?limit=100&status=paid,refunded,in_progress,attention,failed,part_refunded',
    );
    expect(body.items.every((i) => !String(i['order_ref']).startsWith('sx'))).toBe(true);
  });
});

describe('SR1.2 seller sales', () => {
  it('a call with no parameters equals the old answer: every sale, next_cursor null', async () => {
    const { res, body } = await getSales('');
    expect(res.status).toBe(200);
    SellerSalesSchema.parse(body);
    const old = await rig.app.engine.publisherSales(rig.harbour);
    expect(body.items).toEqual(JSON.parse(JSON.stringify(old)));
    expect(body.next_cursor).toBeNull();
    expect(body.items.length).toBeGreaterThanOrEqual(120);
  });

  it('120 sales page as 25, 25, 25, 25, 20', async () => {
    const sizes: number[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const { res, body } = await getSales(
        cursor === null ? '?limit=25' : `?limit=25&cursor=${cursor}`,
      );
      expect(res.status).toBe(200);
      sizes.push(body.items.length);
      for (const i of body.items) seen.add(String(i['unit_id']));
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(sizes).toEqual([25, 25, 25, 25, 20]);
    expect(seen.size).toBe(120);
  });

  it('status narrows, and a paged line has no buyer', async () => {
    const { body } = await getSales('?status=refunded&limit=100');
    expect(body.items).toHaveLength(3);
    const all = await getSales('?limit=100');
    const text = JSON.stringify(all.body);
    for (const w of ['buyer', 'agent_key', 'mandate', 'order_total_minor'])
      expect(text).not.toContain(w);
  });

  it('another seller sees none of these sales', async () => {
    const quay = await rig.key(rig.quayside, ['sales:read']);
    expect((await getSales('?limit=100', quay)).body.items).toEqual([]);
  });
});
