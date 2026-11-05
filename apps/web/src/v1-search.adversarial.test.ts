// INT-SR1 (SR1.7, size L): attacks on the search routes. Wrong keys and sessions get 403; a cursor reused with
// another filter or another principal, and an old o1 cursor sent with a filter, get 400 bad_cursor; no list or
// export crosses a tenant; a seller sending agent_key gets 400 field_not_allowed; injection in `q` matches
// nothing extra; formula cells are neutralised; quick-find answers 429 after 30 calls a minute; a canary `q`
// value is in no log line.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json, seedSales } from './search-support';
import type { Handler, SearchRig, Sess } from './search-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const CANARY = 'CANARY-q-7c1e9d42-do-not-log';
const logs: string[] = [];

let rig: SearchRig;
const h: Record<string, Handler> = {};
let buyerA: string;
let buyerB: string;
let sellerH: string;
let sellerQ: string;
let agent: string;
let opKey: string;
let sessBuyer: Sess;
let sessSeller: Sess;
let sessMfa: Sess;

beforeAll(async () => {
  rig = await bootSearch({}, { log_sink: (line: string) => void logs.push(line) });
  buyerA = await rig.key(rig.buyerA, ['orders:read']);
  buyerB = await rig.key(rig.buyerB, ['orders:read']);
  sellerH = await rig.key(rig.harbour, ['sales:read']);
  sellerQ = await rig.key(rig.quayside, ['sales:read']);
  agent = await rig.key(rig.buyerA, ['orders:read'], 'agent');
  opKey = await rig.key(rig.operator, ['ops:read']);
  sessBuyer = await rig.session(rig.buyerA);
  sessSeller = await rig.session(rig.harbour);
  sessMfa = await rig.session(rig.operator);
  h['orders'] = (await import('./app/api/v1/orders/route')).GET as Handler;
  h['ordersExport'] = (await import('./app/api/v1/orders/export/route')).GET as Handler;
  h['sales'] = (await import('./app/api/v1/seller/sales/route')).GET as Handler;
  h['salesExport'] = (await import('./app/api/v1/seller/sales/export/route')).GET as Handler;
  h['opsKey'] = (await import('./app/api/v1/ops/transactions/route')).GET as Handler;
  h['opsSession'] = (await import('./app/api/ops/transactions/route')).GET as Handler;
  h['opsExport'] = (await import('./app/api/ops/transactions/export/route')).GET as Handler;
  h['find'] = (await import('./app/api/ops/find/route')).GET as Handler;
  const buyerId = (rig.buyerA as { buyer_id: string }).buyer_id;
  const harbour = (rig.harbour as { publisher_id: string }).publisher_id;
  await seedSales(rig.app.db, {
    buyer_id: buyerId,
    publisher_id: harbour,
    count: 6,
    from: new Date(rig.now.getTime() - 86_400_000),
    prefix: 'ad',
  });
});

const v1 = (name: string, token: string | null, url: string) => rig.v1(h[name]!, token, { url });
const sess = (name: string, s: Sess | null, url: string) => rig.old(h[name]!, s, { url });
const items = async (r: Response) => (await json<{ items: Record<string, unknown>[] }>(r)).items;

describe('wrong key or session: 403', () => {
  it('buyer, seller and agent keys cannot reach /api/v1/ops/transactions', async () => {
    for (const t of [buyerA, sellerH, agent])
      expect((await v1('opsKey', t, '/api/v1/ops/transactions')).status).toBe(403);
    expect((await v1('opsKey', null, '/api/v1/ops/transactions')).status).toBe(401);
  });

  it('an operator key cannot use the buyer or seller lists and exports', async () => {
    for (const [n, u] of [
      ['orders', '/api/v1/orders'],
      ['ordersExport', '/api/v1/orders/export'],
      ['sales', '/api/v1/seller/sales'],
      ['salesExport', '/api/v1/seller/sales/export'],
    ] as const)
      expect((await v1(n, opKey, u)).status).toBe(403);
  });

  it('buyer and seller sessions get 403 on the ops list, find and export', async () => {
    for (const s of [sessBuyer, sessSeller]) {
      expect((await sess('opsSession', s, '/api/ops/transactions')).status).toBe(403);
      expect((await sess('find', s, '/api/ops/find?q=abc')).status).toBe(403);
      expect((await sess('opsExport', s, '/api/ops/transactions/export')).status).toBe(403);
    }
    expect((await sess('opsSession', null, '/api/ops/transactions')).status).toBe(401);
  });
});

describe('cursors', () => {
  it('a cursor reused with another filter or by another principal is 400 bad_cursor', async () => {
    const p1 = await json<{ next_cursor: string }>(
      await v1('orders', buyerA, '/api/v1/orders?status=paid&limit=2'),
    );
    expect(p1.next_cursor).toBeTruthy();
    const other = await v1(
      'orders',
      buyerA,
      `/api/v1/orders?status=refunded&limit=2&cursor=${p1.next_cursor}`,
    );
    expect(other.status).toBe(400);
    expect((await json<{ error: { code: string } }>(other)).error.code).toBe('bad_cursor');
    const theirs = await v1(
      'orders',
      buyerB,
      `/api/v1/orders?status=paid&limit=2&cursor=${p1.next_cursor}`,
    );
    expect(theirs.status).toBe(400);
    expect((await json<{ error: { code: string } }>(theirs)).error.code).toBe('bad_cursor');
    const s1 = await json<{ next_cursor: string }>(
      await v1('sales', sellerH, '/api/v1/seller/sales?limit=2'),
    );
    const cross = await v1(
      'sales',
      sellerQ,
      `/api/v1/seller/sales?limit=2&cursor=${s1.next_cursor}`,
    );
    expect(cross.status).toBe(400);
  });

  it('an old o1 cursor sent with a filter is 400 bad_cursor; without a filter it still pages', async () => {
    // What main handed out: base64url of `o1:<id of the last order shown>`.
    const o1 = Buffer.from('o1:ado3').toString('base64url');
    const filtered = await v1('orders', buyerA, `/api/v1/orders?status=paid&cursor=${o1}`);
    expect(filtered.status).toBe(400);
    expect((await json<{ error: { code: string } }>(filtered)).error.code).toBe('bad_cursor');
    const plain = await v1('orders', buyerA, `/api/v1/orders?cursor=${o1}`);
    expect(plain.status).toBe(200);
    expect(await items(plain)).toHaveLength(3);
    expect((await v1('orders', buyerA, '/api/v1/orders?cursor=%00%00')).status).toBe(400);
  });

  it('an operator key cursor does not work in a session and the reverse', async () => {
    const k = await json<{ next_cursor: string }>(
      await v1('opsKey', opKey, '/api/v1/ops/transactions?limit=2'),
    );
    const r = await sess(
      'opsSession',
      sessMfa,
      `/api/ops/transactions?limit=2&cursor=${k.next_cursor}`,
    );
    expect(r.status).toBe(400);
  });
});

describe('tenants', () => {
  it('no list or export crosses a tenant', async () => {
    expect(await items(await v1('orders', buyerB, '/api/v1/orders?limit=100&status=paid'))).toEqual(
      [],
    );
    expect(await items(await v1('sales', sellerQ, '/api/v1/seller/sales?limit=100'))).toEqual([]);
    const bx = await json<{ csv: string }>(
      await v1('ordersExport', buyerB, '/api/v1/orders/export'),
    );
    expect(bx.csv.split('\r\n').filter(Boolean)).toHaveLength(1);
    expect(bx.csv).not.toContain('ad00');
    const sx = await json<{ csv: string }>(
      await v1('salesExport', sellerQ, '/api/v1/seller/sales/export'),
    );
    expect(sx.csv.split('\r\n').filter(Boolean)).toHaveLength(1);
    expect(sx.csv).not.toContain('ad00');
    const own = await json<{ csv: string }>(
      await v1('salesExport', sellerH, '/api/v1/seller/sales/export'),
    );
    expect(own.csv).toContain('000');
    // A buyer cannot name another buyer or a seller.
    const r = await v1('orders', buyerA, '/api/v1/orders?buyer=vs_b2');
    expect(r.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('field_not_allowed');
  });

  it('a seller sending agent_key, buyer, seller, environment or flags gets 400 field_not_allowed', async () => {
    for (const f of [
      'agent_key=x',
      'buyer=vs_b1',
      'seller=x',
      'environment=sandbox',
      'flags=alert',
      'AGENT_KEY=x',
    ]) {
      for (const [n, u] of [
        ['sales', '/api/v1/seller/sales'],
        ['salesExport', '/api/v1/seller/sales/export'],
      ] as const) {
        const r = await v1(n, sellerH, `${u}?${f}`);
        expect(r.status, `${n} ${f}`).toBe(400);
        expect((await json<{ error: { code: string } }>(r)).error.code).toBe('field_not_allowed');
      }
    }
  });
});

describe('injection and formulas', () => {
  it('injection in q matches no extra rows', async () => {
    const base = await items(await v1('orders', buyerA, '/api/v1/orders?limit=100&q=zzz-nothing'));
    expect(base).toEqual([]);
    for (const q of [
      `' OR 1=1 --`,
      `'; DROP TABLE orders; --`,
      '%',
      '_',
      '%25',
      '\\',
      `" OR ""="`,
    ]) {
      const r = await v1('orders', buyerA, `/api/v1/orders?limit=100&q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(await items(r)).toEqual([]);
    }
    expect((await rig.app.db.query('SELECT 1 FROM orders LIMIT 1')).rows).toHaveLength(1);
  });

  it('cells that start with = + - @ tab or CR come out neutralised', async () => {
    for (const lead of ['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd']) {
      await rig.app.db.query(`UPDATE articles SET title = $1 WHERE id = 'vs_a1'`, [lead]);
      const res = await sess(
        'opsExport',
        sessMfa,
        '/api/ops/transactions/export?view=agent_purchases',
      );
      const csv = (await json<{ csv: string }>(res)).csv;
      expect(csv, JSON.stringify(lead)).toContain(`'${lead}`);
      expect(csv).not.toMatch(
        new RegExp(
          `(^|,|")${lead.replace(/[+]/g, '\\+').replace('\t', '\\t').replace('\r', '\\r')}`,
          'm',
        ),
      );
    }
  });
});

describe('quick-find limits and logs', () => {
  it('answers 429 after 30 calls a minute', async () => {
    const fresh = await rig.session({ kind: 'operator', operator_id: 'opr_rate', mfa: true });
    let last = 0;
    let first429 = -1;
    for (let i = 0; i < 31; i++) {
      last = (await sess('find', fresh, `/api/ops/find?q=ref_vs_o${String(i)}`)).status;
      if (last === 429 && first429 < 0) first429 = i;
    }
    expect(first429).toBe(30);
    expect(last).toBe(429);
  });

  it('a canary q value appears in no log line', async () => {
    const q = encodeURIComponent(CANARY);
    await v1('orders', buyerA, `/api/v1/orders?q=${q}`);
    await v1('ordersExport', buyerA, `/api/v1/orders/export?q=${q}`);
    await v1('sales', sellerH, `/api/v1/seller/sales?q=${q}`);
    await v1('opsKey', opKey, `/api/v1/ops/transactions?q=${q}`);
    await sess('opsSession', sessMfa, `/api/ops/transactions?q=${q}`);
    await sess('find', sessMfa, `/api/ops/find?q=${q}`);
    // The log sink and the audit rows (the bearer requests above wrote some) hold the path, never the query.
    const audit = await rig.app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE detail::text LIKE '%7c1e9d42%' OR target LIKE '%7c1e9d42%' OR coalesce(reason, '') LIKE '%7c1e9d42%'`,
    );
    expect(audit.rows[0]!.n).toBe(0);
    expect(logs.filter((l) => l.includes(CANARY))).toEqual([]);
    expect(logs.filter((l) => l.includes('7c1e9d42'))).toEqual([]);
  });
});
