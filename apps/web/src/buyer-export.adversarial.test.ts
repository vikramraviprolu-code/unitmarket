// INT-BUY / BUY.4: attacks on GET /api/buyer/orders/export. The CSV rows equal the filtered list; one buyer never
// gets another's rows; a seller-only key is refused; cells are made safe; only a buyer session may call; the 11th
// call in a minute is limited. The route reuses SR1's buyer export read.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json, seedSales } from './search-support';
import type { Handler, SearchRig } from './search-support';
import { readSpending } from './composition/buyer';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

interface Export {
  filename: string;
  csv: string;
  truncated: boolean;
}
type Buyer = Extract<Actor, { kind: 'buyer' }>;
let rig: SearchRig;
let A: Buyer;
let B: Buyer;
let exportRoute: Handler;
const lines = (csv: string): string[] => csv.split('\r\n').filter((l) => l !== '');

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
  exportRoute = (await import('./app/api/buyer/orders/export/route')).GET as Handler;
}, 120_000);

describe('BUY.4 the export', () => {
  const get = (s: Awaited<ReturnType<SearchRig['session']>> | null, qs = '') =>
    rig.old(exportRoute, s, { url: `/api/buyer/orders/export${qs}` });

  it('the CSV rows equal the filtered list', async () => {
    const s = await rig.session(A);
    const res = await get(s, '?status=refunded');
    expect(res.status).toBe(200);
    const body = await json<Export>(res);
    expect(body.filename).toMatch(/\.csv$/);
    expect(body.truncated).toBe(false);
    const list = await readSpending(A.buyer_id, { status: 'refunded' });
    const rows = lines(body.csv);
    expect(rows).toHaveLength(1 + list.lines.length);
    for (const l of list.lines) expect(body.csv).toContain(l.order_ref);
    expect(lines((await json<Export>(await get(s))).csv)).toHaveLength(1 + 8);
  });

  it("buyer A's export never holds buyer B's rows", async () => {
    const a = await json<Export>(await get(await rig.session(A)));
    expect(a.csv).not.toContain('spb0');
    const b = await json<Export>(await get(await rig.session(B)));
    expect(b.csv).not.toMatch(/sp[ar]\d/);
    expect(lines(b.csv)).toHaveLength(1 + 3);
  });

  it('buyer= gives 400 field_not_allowed', async () => {
    const res = await get(await rig.session(A), `?buyer=${B.buyer_id}`);
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('field_not_allowed');
  });

  it('no cell starts with = + - @ unless it was made safe', async () => {
    const body = await json<Export>(await get(await rig.session(A)));
    const cells = body.csv.split('\r\n').flatMap((l) => l.match(/"(?:[^"]|"")*"|[^,]*/g) ?? []);
    for (const c of cells) expect(c.replace(/^"/, '')).not.toMatch(/^[=+\-@\t\r]/);
  });

  it('a seller session and an operator session are 403, anonymous is 401', async () => {
    for (const actor of [rig.harbour, rig.operator]) {
      const res = await get(await rig.session(actor));
      expect(res.status).toBe(403);
    }
    expect((await get(null)).status).toBe(401);
  });

  it('the 11th export in a minute is 429', async () => {
    const s = await rig.session(B);
    const seen: number[] = [];
    for (let i = 0; i < 11; i++) seen.push((await get(s)).status);
    expect(seen.slice(0, 10)).not.toContain(429);
    expect(seen[10]).toBe(429);
  });

  it('route meta is the stated one (F3)', async () => {
    const m = (await import('./app/api/buyer/orders/export/route')).routeMeta;
    expect(m).toMatchObject({
      path: '/api/buyer/orders/export',
      method: 'GET',
      auth: 'buyer',
      csrf: false,
      idempotent: false,
      risk: 'medium',
      max_body_bytes: 1024,
      rate: { name: 'buyer_export', per: 'actor', limit: 10, window_ms: 60_000 },
    });
  });
});
