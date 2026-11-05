// API-A operator routes O1 to O6, one table-driven case per item id on one booted offline app. All reads:
// an operator key never changes anything (the key-access guard is in scope-a.adversarial.test.ts).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OpsOrderDetailSchema,
  OpsOverviewSchema,
  OpsReconcilerSchema,
  OpsSwitchesSchema,
  StatusSchema,
  V1_ROUTES,
  buildOpenApiV1,
} from '@umsbx/contracts';
import { HARBOUR_TIDE, startPack } from '../../../composite-support';
import { bootA, type ARig, type Handler } from '../../../api-v1/a-support';
import { expectOffline } from '../../../api-v1/offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

let rig: ARig;
let tok: string;
const h: Record<string, Handler> = {};
let order_ref = '';

beforeAll(async () => {
  rig = await bootA();
  tok = await rig.key(rig.operator, ['ops:read']);
  h['overview'] = (await import('./ops/overview/route')).GET as Handler;
  h['reconciler'] = (await import('./ops/reconciler/route')).GET as Handler;
  h['order'] = (await import('./ops/orders/[ref]/route')).GET as Handler;
  h['switches'] = (await import('./ops/switches/route')).GET as Handler;
  h['status'] = (await import('./status/route')).GET as Handler;
  h['healthz'] = (await import('../../healthz/route')).GET as Handler;
  order_ref = (await startPack(rig.app, rig.buyerA, [HARBOUR_TIDE])).order_ref;
});

const get = (
  name: string,
  url: string,
  params?: Record<string, string>,
  token: string | null = tok,
) => rig.v1(h[name]!, token, { url, ...(params ? { params } : {}) });

const CASES: [string, () => Promise<void>][] = [
  [
    'O1 GET /api/v1/ops/overview',
    async () => {
      const res = await get('overview', '/api/v1/ops/overview');
      expect(res.status).toBe(200);
      const v1 = OpsOverviewSchema.parse(await res.json());
      const snap = (await rig.app.engine.opsSnapshot(rig.operator))!;
      expect(v1.environment).toBe(snap.environment);
      expect(v1.orders).toEqual(snap.orders);
      expect(v1.operations).toEqual(snap.operations);
      expect(v1.alerts).toEqual(snap.alerts);
      expect(v1.invariants).toEqual(
        snap.invariants.map(({ id, ok, detail }) => ({ id, ok, detail })),
      );
      expect(v1.jobs).toEqual(snap.jobs);
      expect(v1.orders.map((o) => o.order_ref)).toContain(order_ref);
      // No buyer or publisher identity, and no credential-shaped value.
      expect(JSON.stringify(v1)).not.toMatch(/buy_|pub_|persona:|Bearer|umk_/);
    },
  ],
  [
    'O2 GET /api/v1/ops/reconciler',
    async () => {
      const res = await get('reconciler', '/api/v1/ops/reconciler');
      expect(res.status).toBe(200);
      const v1 = OpsReconcilerSchema.parse(await res.json());
      const snap = (await rig.app.engine.opsSnapshot(rig.operator))!;
      expect(v1.last_pass_at).toBe(snap.jobs.last_pass_at);
      expect(v1.due).toBe(snap.jobs.due);
      expect(v1.operations).toEqual(snap.operations);
      expect(v1.alerts).toEqual(snap.alerts);
    },
  ],
  [
    'O3 GET /api/v1/ops/orders/{ref}',
    async () => {
      const res = await get('order', `/api/v1/ops/orders/${order_ref}`, { ref: order_ref });
      expect(res.status).toBe(200);
      const v1 = OpsOrderDetailSchema.parse(await res.json());
      const row = (
        await rig.app.db.query<{
          status: string;
          total_minor: string | number;
          currency: string;
          environment: string;
        }>('SELECT status, total_minor, currency, environment FROM orders WHERE order_ref = $1', [
          order_ref,
        ])
      ).rows[0]!;
      expect(v1).toMatchObject({
        order_ref,
        status: row.status,
        total_minor: Number(row.total_minor),
        currency: row.currency,
        environment: row.environment,
      });
      expect(v1.units.length).toBeGreaterThan(0);
      expect(v1.provider_orders.length).toBeGreaterThan(0);
      // The orders in the overview list carry the same status as the detail.
      const overview = OpsOverviewSchema.parse(
        await (await get('overview', '/api/v1/ops/overview')).json(),
      );
      expect(overview.orders.find((o) => o.order_ref === order_ref)?.status).toBe(v1.status);
      // No buyer identity, no PayPal order id or merchant id.
      expect(JSON.stringify(v1)).not.toMatch(/buy_|pub_|persona:|merchant/i);
      expect(
        (await get('order', '/api/v1/ops/orders/ord_nothing', { ref: 'ord_nothing' })).status,
      ).toBe(404);
    },
  ],
  [
    'O4 GET /api/v1/ops/switches',
    async () => {
      const res = await get('switches', '/api/v1/ops/switches');
      expect(res.status).toBe(200);
      const v1 = OpsSwitchesSchema.parse(await res.json());
      const snap = (await rig.app.engine.opsSnapshot(rig.operator))!;
      expect(v1.environment).toBe(snap.environment);
      expect(v1.switches).toEqual(snap.switches);
      expect(v1.kill_switch.outbound_on).toBe(snap.kill_switch.outbound_on);
      expect(v1.gate).toMatchObject({
        mode: snap.gate.mode,
        connect: snap.gate.connect,
        approval_ref_set: snap.gate.approval_ref_set,
      });
      // Dry-run: no PayPal lock block. (The dry-run seed turns paypal_outbound on because that transport opens
      // no socket; the answer says what the stored switch says, which toEqual(snap.switches) above checks.)
      expect(v1.gate.locks).toBeNull();
      expect(snap.environment).toBe('dryrun');
    },
  ],
  [
    'O5 GET /api/v1/status',
    async () => {
      const res = await get('status', '/api/v1/status', undefined, null);
      expect(res.status).toBe(200);
      const v1 = StatusSchema.parse(await res.json());
      const old = await rig.old(h['healthz']!, null, { url: '/healthz' });
      // INT-CL1 (F11): the /healthz body plus `revision` (null off Cloud Run) and `db`; the assertion is moved, not weakened.
      expect(v1).toEqual({ ...(await old.json()), revision: null, db: 'up' });
      // Public: it answers with a key too, and says nothing about switches.
      expect(JSON.stringify(v1)).not.toMatch(/switch|outbound|lock/);
    },
  ],
  [
    'O6 POST /api/webhooks/paypal is listed as the inbound webhook, unchanged',
    async () => {
      // The inbound webhook is not under /api/v1, so the file lists it in the OpenAPI 3.1 `webhooks` map.
      const doc = buildOpenApiV1() as {
        webhooks: Record<string, Record<string, { summary?: string; security?: unknown[] }>>;
      };
      const op = doc.webhooks['payment-provider-events']?.['post'];
      expect(op).toBeDefined();
      expect(op!.summary ?? '').toMatch(/inbound|webhook/i);
      // No new route: nothing under /api/v1 handles a webhook, and the existing route file is still there.
      expect(existsSync(fileURLToPath(new URL('./webhooks', import.meta.url)))).toBe(false);
      expect(
        existsSync(fileURLToPath(new URL('../webhooks/paypal/route.ts', import.meta.url))),
      ).toBe(true);
    },
  ],
];

describe('API-A operator routes', () => {
  it.each(CASES)('%s', async (_id, run) => {
    await run();
  });
});

describe('API-A operator routes are registered for the OpenAPI file', () => {
  it('lists O1 to O5 as GET routes that need ops:read (O5 is public)', () => {
    const by = (p: string) => V1_ROUTES.find((r) => r.path === p);
    for (const p of [
      '/api/v1/ops/overview',
      '/api/v1/ops/reconciler',
      '/api/v1/ops/orders/{ref}',
      '/api/v1/ops/switches',
    ]) {
      const r = by(p);
      expect(r, p).toBeDefined();
      expect(r!.method).toBe('GET');
      expect(r!.auth).toBe('apikey');
      expect([...r!.scopes]).toEqual(['ops:read']);
    }
    expect(by('/api/v1/status')?.auth).toBe('public');
  });
  it('no operator route changes anything: every ops path is a GET', () => {
    expect(V1_ROUTES.filter((r) => r.path.includes('/ops/')).every((r) => r.method === 'GET')).toBe(
      true,
    );
  });
});
