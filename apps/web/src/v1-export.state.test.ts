// INT-SR1 (SR1.5): CSV of the current filter for buyer orders, seller sales and (session) operator
// transactions. PUB-E1 shape: a JSON answer { filename, csv, truncated }; no text/csv, at most 5,000 rows.
// Cells go through csvCell (= + - @ tab CR). The seller file has no buyer column. The operator session file
// has identity columns only with MFA.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json, seedBulkSales, seedSales } from './search-support';
import type { Handler, SearchRig, Sess } from './search-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

interface Export {
  filename: string;
  csv: string;
  truncated: boolean;
}
type Item = Record<string, unknown>;

let rig: SearchRig;
let buyerKey: string;
let sellerKey: string;
let mfa: Sess;
let noMfa: Sess;
const h: Record<string, Handler> = {};
const buyerId = () => (rig.buyerA as { buyer_id: string }).buyer_id;
const harbourId = () => (rig.harbour as { publisher_id: string }).publisher_id;
const lines = (csv: string): string[] => csv.split('\r\n').filter((l) => l !== '');

beforeAll(async () => {
  rig = await bootSearch();
  buyerKey = await rig.key(rig.buyerA, ['orders:read']);
  sellerKey = await rig.key(rig.harbour, ['sales:read']);
  mfa = await rig.session(rig.operator);
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_nomfa', mfa: false });
  h['orders'] = (await import('./app/api/v1/orders/route')).GET as Handler;
  h['ordersExport'] = (await import('./app/api/v1/orders/export/route')).GET as Handler;
  h['salesExport'] = (await import('./app/api/v1/seller/sales/export/route')).GET as Handler;
  h['sales'] = (await import('./app/api/v1/seller/sales/route')).GET as Handler;
  h['opsExport'] = (await import('./app/api/ops/transactions/export/route')).GET as Handler;
  const from = new Date(rig.now.getTime() - 5 * 86_400_000);
  await seedSales(rig.app.db, {
    buyer_id: buyerId(),
    publisher_id: harbourId(),
    count: 7,
    from,
    prefix: 'ex',
  });
  await seedSales(rig.app.db, {
    buyer_id: buyerId(),
    publisher_id: harbourId(),
    count: 2,
    from: new Date(from.getTime() + 3_600_000),
    prefix: 'ey',
    status: 'refunded',
  });
});

describe('SR1.5 buyer and seller CSV', () => {
  it('the buyer CSV rows equal the filtered list', async () => {
    const res = await rig.v1(h['ordersExport']!, buyerKey, {
      url: '/api/v1/orders/export?status=refunded',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await json<Export>(res);
    expect(body.filename).toMatch(/\.csv$/);
    expect(body.truncated).toBe(false);
    const list = await json<{ items: Item[] }>(
      await rig.v1(h['orders']!, buyerKey, { url: '/api/v1/orders?status=refunded&limit=100' }),
    );
    const rows = lines(body.csv);
    expect(rows.length).toBe(1 + list.items.length);
    expect(rows[0]).toContain('order_ref');
    for (const i of list.items) expect(body.csv).toContain(String(i['order_ref']));
    const all = await json<Export>(
      await rig.v1(h['ordersExport']!, buyerKey, { url: '/api/v1/orders/export' }),
    );
    expect(lines(all.csv)).toHaveLength(1 + 9);
  });

  it('the seller CSV has no buyer column and no buyer value', async () => {
    const res = await rig.v1(h['salesExport']!, sellerKey, { url: '/api/v1/seller/sales/export' });
    expect(res.status).toBe(200);
    const body = await json<Export>(res);
    const rows = lines(body.csv);
    expect(rows).toHaveLength(1 + 9);
    const header = rows[0]!.toLowerCase();
    for (const w of ['buyer', 'agent', 'mandate', 'total']) expect(header).not.toContain(w);
    expect(body.csv).not.toContain(buyerId());
    const refunded = await json<Export>(
      await rig.v1(h['salesExport']!, sellerKey, {
        url: '/api/v1/seller/sales/export?status=refunded',
      }),
    );
    expect(lines(refunded.csv)).toHaveLength(1 + 2);
  });

  it('a cursor or limit does not change what is exported', async () => {
    const a = await json<Export>(
      await rig.v1(h['ordersExport']!, buyerKey, { url: '/api/v1/orders/export?limit=2' }),
    );
    expect(lines(a.csv)).toHaveLength(1 + 9);
  });
});

describe('SR1.5 operator session CSV', () => {
  it('has identity columns with MFA and none without', async () => {
    const withMfa = await json<Export>(
      await rig.old(h['opsExport']!, mfa, {
        url: '/api/ops/transactions/export?view=agent_purchases',
      }),
    );
    expect(lines(withMfa.csv)).toHaveLength(1 + 5);
    expect(withMfa.csv).toContain('Wes Watcher');
    expect(withMfa.csv).toContain('Quay Views');
    expect(withMfa.csv).toMatch(/PAYPALVS/);
    const res = await rig.old(h['opsExport']!, noMfa, {
      url: '/api/ops/transactions/export?view=agent_purchases',
    });
    expect(res.status).toBe(200);
    const without = await json<Export>(res);
    expect(lines(without.csv)).toHaveLength(1 + 5);
    for (const w of [
      'Wes Watcher',
      'Quay Views',
      'PAYPALVS',
      'buyer_name',
      'seller_name',
      'provider_order_id',
    ])
      expect(without.csv).not.toContain(w);
  });
});

describe('SR1.5 truncation', () => {
  it('is false at 5,000 rows and true above', async () => {
    const q = {
      buyer_id: buyerId(),
      publisher_id: harbourId(),
      merchant: 'MERCHBULK',
      corridor: 'x',
      count: 5000,
      prefix: 'bk',
      from: new Date(rig.now.getTime() - 20 * 86_400_000),
    };
    const corridor = (
      await rig.app.db.query<{ id: string }>(
        `SELECT id FROM corridors WHERE currency = 'USD' AND enabled LIMIT 1`,
      )
    ).rows[0]!.id;
    const merchant = (
      await rig.app.db.query<{ m: string }>(
        'SELECT paypal_merchant_id AS m FROM publishers WHERE id = $1',
        [harbourId()],
      )
    ).rows[0]!.m;
    await seedBulkSales(rig.app.db as unknown as { exec(sql: string): Promise<unknown> }, {
      ...q,
      corridor,
      merchant,
    });
    const full = await json<Export>(
      await rig.v1(h['ordersExport']!, buyerKey, {
        url: '/api/v1/orders/export?from=2020-01-01&max_minor=500&min_minor=500',
      }),
    );
    // 5,000 bulk lines + the 9 above: 5,009 matched, 5,000 written.
    expect(full.truncated).toBe(true);
    expect(lines(full.csv)).toHaveLength(1 + 5000);
    const small = await json<Export>(
      await rig.v1(h['ordersExport']!, buyerKey, { url: '/api/v1/orders/export?status=refunded' }),
    );
    expect(small.truncated).toBe(false);
  }, 300_000);
});
