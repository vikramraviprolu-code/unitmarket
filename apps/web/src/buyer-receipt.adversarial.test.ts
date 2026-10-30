// UX-1A addendum, item 54: the buyer receipt JSON carries no merchant id, by key or by value, whatever
// the route is asked. The domain receipt still holds the payee in its hashed snapshot; this is the door
// a buyer reaches, and it must not pass it on.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './support';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
let unit: BoughtUnit;
let merchantIds: string[];

beforeAll(async () => {
  w = await bootRefundWorld();
  unit = await buy(w, { offer: 'tide-tables', option: 'online_read' });
  const rows = await w.app.db.query<{ m: string | null }>(
    `SELECT paypal_merchant_id AS m FROM publishers WHERE paypal_merchant_id IS NOT NULL`,
  );
  const snap = await w.app.db.query<{ snapshot: unknown }>(
    'SELECT snapshot FROM approvals ORDER BY created_at DESC LIMIT 1',
  );
  const text = JSON.stringify(snap.rows[0]!.snapshot);
  merchantIds = [
    ...rows.rows.map((r) => r.m!),
    ...[...text.matchAll(/"payee_merchant_id":"([^"]+)"/g)].map((m) => m[1]!),
  ];
});
afterAll(async () => {
  await w.app.close();
});

const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  return out;
};

describe('GET /api/receipts/[order] as the buyer', () => {
  it('has no merchant or payee key at any depth, and no merchant id value anywhere in the text', async () => {
    expect(merchantIds.length).toBeGreaterThan(0);
    const res = await call(w.receipts.GET, {
      url: `/api/receipts/${unit.order_id}`,
      session: w.A,
      params: { order: unit.order_id },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as unknown;
    expect(keysDeep(body).filter((k) => /merchant|payee/i.test(k))).toEqual([]);
    for (const id of merchantIds) expect(text).not.toContain(id);
    expect(text).not.toMatch(/merchant/i);
  });

  it('names the article and the publisher, and keeps the hash and the version', async () => {
    const res = await call(w.receipts.GET, {
      url: `/api/receipts/${unit.order_id}`,
      session: w.A,
      params: { order: unit.order_id },
    });
    const b = (await res.json()) as {
      sha256: string;
      version: number;
      lines: { title: string; publisher: string }[];
    };
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.version).toBeGreaterThanOrEqual(1);
    expect(b.lines[0]!.title.length).toBeGreaterThan(0);
    expect(b.lines[0]!.publisher.length).toBeGreaterThan(0);
  });

  it('another buyer and a visitor get nothing, and the 404 body names no merchant either', async () => {
    const other = await call(w.receipts.GET, {
      url: `/api/receipts/${unit.order_id}`,
      session: w.B,
      params: { order: unit.order_id },
    });
    expect(other.status).toBe(404);
    const anon = await call(w.receipts.GET, {
      url: `/api/receipts/${unit.order_id}`,
      session: null,
      params: { order: unit.order_id },
    });
    expect([401, 403]).toContain(anon.status);
    for (const res of [other, anon]) expect(await res.text()).not.toMatch(/merchant/i);
  });
});
