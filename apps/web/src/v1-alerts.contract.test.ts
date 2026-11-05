// INT-AL AL.1 and AL.7 over the wire: GET /api/v1/ops/alerts, /alerts/{id}, /cases and /cases/{id}. Reads only,
// apikey with ops:read, answers that match the schemas in contracts/v1-alerts.ts and carry no identity.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AlertDetailSchema,
  AlertListSchema,
  CaseDetailSchema,
  CaseListSchema,
  V1_ROUTES,
} from '@umsbx/contracts';
import { HARBOUR_TIDE, startPack } from './composite-support';
import { bootAlertRig, seedAlert } from './ops-alerts-support';
import type { AlertRig, Handler } from './ops-alerts-support';

vi.mock('server-only', () => ({}));

let r: AlertRig;
const h: Record<string, Handler> = {};
let orderId = '';
let orderRef = '';
const get = (
  name: string,
  url: string,
  params?: Record<string, string>,
  token: string | null = r.opKey,
) => r.rig.v1(h[name]!, token, { url, ...(params ? { params } : {}) });

beforeAll(async () => {
  r = await bootAlertRig();
  h['alerts'] = (await import('./app/api/v1/ops/alerts/route')).GET as Handler;
  h['alert'] = (await import('./app/api/v1/ops/alerts/[id]/route')).GET as Handler;
  h['cases'] = (await import('./app/api/v1/ops/cases/route')).GET as Handler;
  h['case'] = (await import('./app/api/v1/ops/cases/[id]/route')).GET as Handler;
  const p = await startPack(r.rig.app, r.rig.buyerA, [HARBOUR_TIDE]);
  orderRef = p.order_ref;
  orderId = (
    await r.rig.app.db.query<{ id: string }>('SELECT id FROM orders WHERE order_ref = $1', [
      orderRef,
    ])
  ).rows[0]!.id;
  for (let i = 1; i <= 3; i++) {
    await seedAlert(r.rig, {
      id: `alr_v${i}`,
      kind: 'frozen_order',
      reason: `v${i}`,
      order_id: orderId,
    });
  }
  const at = '2026-11-05T10:00:00.000Z';
  await r.rig.app.db.query(
    `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
     SELECT 'cas_v1', 'frozen_order', 'open', id, NULL, buyer_id, 'system', $2::timestamptz, 0, 'We are looking into your payment.', $2::timestamptz, $2::timestamptz FROM orders WHERE id = $1`,
    [orderId, at],
  );
});
afterAll(async () => r.rig.app.close());

describe('alerts over the wire', () => {
  it('the list answers the schema, with total, filters and a cursor', async () => {
    const res = await get('alerts', '/api/v1/ops/alerts?limit=2&state=open&kind=frozen_order');
    expect(res.status).toBe(200);
    const body = AlertListSchema.parse(await res.json());
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.next_cursor).not.toBeNull();
    expect(body.items[0]).toMatchObject({
      kind: 'frozen_order',
      order_ref: orderRef,
      state: 'open',
    });
  });

  it('a bad filter is a 400 or 422, not an empty list', async () => {
    expect([400, 422]).toContain((await get('alerts', '/api/v1/ops/alerts?state=nope')).status);
    expect([400, 422]).toContain((await get('alerts', '/api/v1/ops/alerts?limit=0')).status);
  });

  it('one alert answers the schema with its history; an unknown one is 404', async () => {
    const res = await get('alert', '/api/v1/ops/alerts/alr_v1', { id: 'alr_v1' });
    expect(AlertDetailSchema.parse(await res.json()).id).toBe('alr_v1');
    expect((await get('alert', '/api/v1/ops/alerts/alr_none', { id: 'alr_none' })).status).toBe(
      404,
    );
  });

  it('only an operator key with ops:read reads', async () => {
    const buyerKey = await r.rig.key(r.rig.buyerA, ['orders:read']);
    expect((await get('alerts', '/api/v1/ops/alerts', undefined, buyerKey)).status).toBe(403);
    expect((await get('alerts', '/api/v1/ops/alerts', undefined, null)).status).toBe(401);
  });
});

describe('cases over the wire', () => {
  it('the queue and the detail answer their schemas; the message text is not in them', async () => {
    const list = CaseListSchema.parse(
      await (await get('cases', '/api/v1/ops/cases?state=unresolved')).json(),
    );
    expect(list.items.map((c) => c.case_id)).toContain('cas_v1');
    const res = await get('case', '/api/v1/ops/cases/cas_v1', { id: 'cas_v1' });
    expect(res.status).toBe(200);
    const text = await res.text();
    const d = CaseDetailSchema.parse(JSON.parse(text));
    expect(d.buyer_message_present).toBe(true);
    expect(d.allowed_actions).toContain('offer_refund');
    expect(text).not.toContain('We are looking into your payment');
    expect((await get('case', '/api/v1/ops/cases/cas_none', { id: 'cas_none' })).status).toBe(404);
  });

  it('carries no buyer or publisher identity', async () => {
    const text = JSON.stringify([
      await (await get('alerts', '/api/v1/ops/alerts?limit=100')).json(),
      await (await get('cases', '/api/v1/ops/cases')).json(),
      await (await get('case', '/api/v1/ops/cases/cas_v1', { id: 'cas_v1' })).json(),
    ]);
    for (const bad of ['buy_', 'harbour-ledger', 'MERCH', 'pub_']) expect(text).not.toContain(bad);
  });
});

describe('registry', () => {
  it('lists the five reads under ops:read and nothing that writes', () => {
    const paths = V1_ROUTES.filter((x) => x.path.startsWith('/api/v1/ops')).map(
      (x) => `${x.method} ${x.path}`,
    );
    for (const p of [
      'GET /api/v1/ops/alerts',
      'GET /api/v1/ops/alerts/{id}',
      'GET /api/v1/ops/needs-you',
      'GET /api/v1/ops/cases',
      'GET /api/v1/ops/cases/{id}',
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths.every((p) => p.startsWith('GET '))).toBe(true);
  });
});
