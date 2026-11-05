// INT-SEL / SEL.2 adversarial: GET /api/publisher/sales/export. The route is a seller session route. Its CSV has
// no buyer column and no order total, and the canary total and refund reason are in no cell. Refused filters
// give 400 field_not_allowed. Buyer and operator sessions get 403, nobody 401, the 11th request in a minute 429.
// Seller A never gets seller B's rows. Cells that start with = + - @ are made safe.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANARY, IDS, bootSeller } from './seller-fixture';
import type { SellerRig } from './seller-fixture';
import type { Handler, Sess } from './search-support';

vi.mock('server-only', () => ({}));

let rig: SellerRig;
let route: typeof import('./app/api/publisher/sales/export/route');
let sA: Sess;
let sB: Sess;
let sBuyer: Sess;
let sOp: Sess;

beforeAll(async () => {
  rig = await bootSeller();
  route = await import('./app/api/publisher/sales/export/route');
  sA = await rig.session(rig.A);
  sB = await rig.session(rig.B);
  sBuyer = await rig.session(rig.vsBuyer1);
  sOp = await rig.session(rig.operator);
}, 120_000);
afterAll(async () => {
  await rig.app.close();
});
beforeEach(async () => {
  await rig.app.db.query('DELETE FROM rate_buckets');
});

const get = (s: Sess | null, qs = '') =>
  rig.old(route.GET as unknown as Handler, s, { url: `/api/publisher/sales/export${qs}` });
const csvOf = async (
  res: Response,
): Promise<{ filename: string; csv: string; truncated: boolean }> =>
  (await res.json()) as { filename: string; csv: string; truncated: boolean };

describe('route meta', () => {
  it('is a seller session GET, not CSRF-checked, not idempotent, medium risk, 10 a minute per actor', () => {
    expect(route.routeMeta).toMatchObject({
      path: '/api/publisher/sales/export',
      method: 'GET',
      auth: 'publisher',
      csrf: false,
      idempotent: false,
      risk: 'medium',
      max_body_bytes: 1024,
      rate: { name: 'publisher_sales_export', per: 'actor', limit: 10, window_ms: 60_000 },
    });
  });
});

describe('the file', () => {
  it('holds seller A rows only, in the current filter, with no buyer column and no order total', async () => {
    const res = await get(sA);
    expect(res.status).toBe(200);
    const { filename, csv } = await csvOf(res);
    expect(filename).toMatch(/^sales-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(1 + 6);
    const header = lines[0]!;
    for (const bad of ['buyer', 'agent', 'mandate', 'order_total', 'reason', 'seller'])
      expect(header, bad).not.toContain(bad);
    for (const bad of [
      CANARY.buyerName,
      'CANARY',
      CANARY.reason,
      String(CANARY.total),
      CANARY.totalText,
      'Birch',
      'vs_b',
      '4442',
      '44.42',
      'phone',
    ])
      expect(csv, bad).not.toContain(bad);
  });

  it('rows equal the filtered list', async () => {
    const refunds = await csvOf(await get(sA, '?refund=partial,full'));
    expect(refunds.csv.trim().split('\r\n').length).toBe(1 + 1);
    const pending = await csvOf(await get(sA, '?status=in_progress'));
    expect(pending.csv.trim().split('\r\n').length).toBe(1 + 1);
  });

  it("seller A never gets seller B's rows, and seller B gets its own", async () => {
    const a = (await csvOf(await get(sA))).csv;
    const b = (await csvOf(await get(sB))).csv;
    expect(a).not.toContain('Birch');
    expect(b.trim().split('\r\n').length).toBe(1 + 2);
    expect(b).not.toContain('Alder');
  });

  it('a formula in an article title is exported with a leading quote', async () => {
    await rig.app.db.query(
      `UPDATE articles SET title = '=HYPERLINK("http://x","y")' WHERE id = 'sl_a2'`,
    );
    const { csv } = await csvOf(await get(sA));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")`);
    for (const line of csv.split('\r\n'))
      for (const cell of line.split(',')) expect(/^["]?[=+\-@]/.test(cell), cell).toBe(false);
    await rig.app.db.query(`UPDATE articles SET title = 'Alder Almanac' WHERE id = 'sl_a2'`);
  });
});

describe('refusals', () => {
  it('buyer=, agent_key= and seller= with any value give 400 field_not_allowed', async () => {
    for (const q of [
      'buyer=x',
      'buyer=',
      'agent_key=k',
      'seller=sl_pb',
      'seller=',
      'environment=sandbox',
      'flags=x',
    ]) {
      const res = await get(sA, `?${q}`);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code, q).toBe(
        'field_not_allowed',
      );
    }
  });

  it('a buyer session and an operator session get 403, nobody gets 401', async () => {
    expect((await get(sBuyer)).status).toBe(403);
    expect((await get(sOp)).status).toBe(403);
    expect((await get(null)).status).toBe(401);
  });

  it('the 11th export in a minute is 429', async () => {
    for (let i = 0; i < 10; i++) expect((await get(sA)).status, String(i)).toBe(200);
    expect((await get(sA)).status).toBe(429);
  });

  it('the file holds nothing of the unit ids of another seller even by a guessed filter', async () => {
    const res = await get(sA, `?ref=${IDS.uB}`);
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) expect((await csvOf(res)).csv).not.toContain('Birch');
  });
});
