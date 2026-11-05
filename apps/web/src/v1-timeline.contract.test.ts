// INT-TR1 / TR1.3: the three v1 timeline routes and GET /api/v1/ops/trace/verify, on one booted offline app.
// Each answer matches v1-trace.ts and the OpenAPI file; the scopes orders:read, sales:read and ops:read are
// enforced; a buyer key gets 403 on both ops routes; an agent key reads its own buyer; a seller reads only its
// own unit. A type-level case shows the contract entry is assignable to UI0's TimelineEntryView.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TimelineAnswerSchema,
  TimelineEntrySchema,
  TraceVerifySchema,
  V1_ROUTES,
  buildOpenApiV1,
} from '@umsbx/contracts';
import type { TimelineEntry } from '@umsbx/contracts';
import { HARBOUR_TIDE, QUAY_MARKET, startPack } from './composite-support';
import { bootA } from './api-v1/a-support';
import type { ARig, Handler } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import type { TimelineEntryView } from './lib/timeline-view';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Type-level: the contract entry can be given to UI0's component type.
const _assignable = (e: TimelineEntry): TimelineEntryView => e;
void _assignable;

let rig: ARig;
let ref = '';
let unitH = '';
let unitQ = '';
const h: Record<string, Handler> = {};
let buyerTok: string;
let agentTok: string;
let otherBuyerTok: string;
let harbourTok: string;
let quaysideTok: string;
let opsTok: string;

beforeAll(async () => {
  rig = await bootA();
  h['order'] = (await import('./app/api/v1/orders/[ref]/timeline/route')).GET as Handler;
  h['sale'] = (await import('./app/api/v1/seller/sales/[unit]/timeline/route')).GET as Handler;
  h['ops'] = (await import('./app/api/v1/ops/orders/[ref]/timeline/route')).GET as Handler;
  h['verify'] = (await import('./app/api/v1/ops/trace/verify/route')).GET as Handler;
  ref = (await startPack(rig.app, rig.buyerA, [HARBOUR_TIDE, QUAY_MARKET])).order_ref;
  const units = (
    await rig.app.db.query<{ id: string; slug: string }>(
      `SELECT u.id, p.slug FROM order_units u JOIN orders o ON o.id = u.order_id JOIN publishers p ON p.id = u.publisher_id WHERE o.order_ref = $1`,
      [ref],
    )
  ).rows;
  unitH = units.find((u) => u.slug === 'harbour-ledger')!.id;
  unitQ = units.find((u) => u.slug === 'quayside-gazette')!.id;
  buyerTok = await rig.key(rig.buyerA, ['orders:read']);
  agentTok = await rig.key(rig.buyerA, ['orders:read'], 'agent');
  otherBuyerTok = await rig.key(rig.buyerB, ['orders:read']);
  harbourTok = await rig.key(rig.harbour, ['sales:read']);
  quaysideTok = await rig.key(rig.quayside, ['sales:read']);
  opsTok = await rig.key(rig.operator, ['ops:read']);
});

const get = (
  name: string,
  url: string,
  params: Record<string, string> | undefined,
  tok: string | null,
) => rig.v1(h[name]!, tok, { url, ...(params ? { params } : {}) });
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('buyer timeline', () => {
  it('matches the schema for a buyer key and an agent key, and carries no operator context', async () => {
    for (const tok of [buyerTok, agentTok]) {
      const r = await get('order', `/api/v1/orders/${ref}/timeline`, { ref }, tok);
      expect(r.status).toBe(200);
      const t = TimelineAnswerSchema.parse(await r.json());
      expect(t.entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(t)).not.toMatch(/req_|ip_hash|ua_family|api_key_id|trace_context|opr_/);
    }
  });
  it('another buyer and an unknown ref get the same 404 body', async () => {
    const other = await get('order', `/api/v1/orders/${ref}/timeline`, { ref }, otherBuyerTok);
    const none = await get(
      'order',
      '/api/v1/orders/ord_nothing/timeline',
      { ref: 'ord_nothing' },
      otherBuyerTok,
    );
    expect(other.status).toBe(404);
    expect(none.status).toBe(404);
    expect(await body(other)).toEqual(await body(none));
  });
  it('needs the scope and the right kind of key', async () => {
    expect((await get('order', `/api/v1/orders/${ref}/timeline`, { ref }, null)).status).toBe(401);
    expect((await get('order', `/api/v1/orders/${ref}/timeline`, { ref }, harbourTok)).status).toBe(
      403,
    );
    expect((await get('order', `/api/v1/orders/${ref}/timeline`, { ref }, opsTok)).status).toBe(
      403,
    );
    const noScope = await rig.key(rig.buyerA, ['catalogue:read']);
    expect((await get('order', `/api/v1/orders/${ref}/timeline`, { ref }, noScope)).status).toBe(
      403,
    );
  });
});

describe('seller timeline', () => {
  it('a seller reads its own unit and gets 404 on the other seller unit', async () => {
    const mine = await get(
      'sale',
      `/api/v1/seller/sales/${unitH}/timeline`,
      { unit: unitH },
      harbourTok,
    );
    expect(mine.status).toBe(200);
    const t = TimelineAnswerSchema.parse(await mine.json());
    const text = JSON.stringify(t);
    expect(text).not.toContain(unitQ);
    expect(text).not.toContain('total_minor');
    expect(text).not.toMatch(/buy_|persona:/);
    const theirs = await get(
      'sale',
      `/api/v1/seller/sales/${unitQ}/timeline`,
      { unit: unitQ },
      harbourTok,
    );
    const none = await get(
      'sale',
      '/api/v1/seller/sales/unt_nothing/timeline',
      { unit: 'unt_nothing' },
      harbourTok,
    );
    expect(theirs.status).toBe(404);
    expect(await body(theirs)).toEqual(await body(none));
    expect(
      (await get('sale', `/api/v1/seller/sales/${unitQ}/timeline`, { unit: unitQ }, quaysideTok))
        .status,
    ).toBe(200);
  });
  it('a buyer key and an ops key get 403', async () => {
    expect(
      (await get('sale', `/api/v1/seller/sales/${unitH}/timeline`, { unit: unitH }, buyerTok))
        .status,
    ).toBe(403);
    expect(
      (await get('sale', `/api/v1/seller/sales/${unitH}/timeline`, { unit: unitH }, opsTok)).status,
    ).toBe(403);
  });
});

describe('operator routes', () => {
  it('the ops timeline answers for an ops key, identity free', async () => {
    const r = await get('ops', `/api/v1/ops/orders/${ref}/timeline`, { ref }, opsTok);
    expect(r.status).toBe(200);
    const t = TimelineAnswerSchema.parse(await r.json());
    expect(t.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(t)).not.toMatch(/buy_|pub_|req_|ip_hash|api_key_id|persona:/);
    expect(
      (await get('ops', '/api/v1/ops/orders/ord_nothing/timeline', { ref: 'ord_nothing' }, opsTok))
        .status,
    ).toBe(404);
  });
  it('a buyer key and a seller key get 403 on both ops routes', async () => {
    for (const tok of [buyerTok, agentTok, harbourTok]) {
      expect((await get('ops', `/api/v1/ops/orders/${ref}/timeline`, { ref }, tok)).status).toBe(
        403,
      );
      expect((await get('verify', '/api/v1/ops/trace/verify', undefined, tok)).status).toBe(403);
    }
  });
  it('verify answers { ok, chains, rows, seals, drift } and nothing about rows', async () => {
    const r = await get('verify', '/api/v1/ops/trace/verify', undefined, opsTok);
    expect(r.status).toBe(200);
    const v = TraceVerifySchema.parse(await r.json());
    expect(Object.keys(v).sort()).toEqual(['chains', 'drift', 'ok', 'rows', 'seals']);
    expect(v.rows).toBeGreaterThan(0);
    expect(v.chains).toBeGreaterThan(0);
  });
});

describe('contract and OpenAPI', () => {
  const PATHS = [
    ['GET', '/api/v1/orders/{ref}/timeline', 'orders:read'],
    ['GET', '/api/v1/seller/sales/{unit}/timeline', 'sales:read'],
    ['GET', '/api/v1/ops/orders/{ref}/timeline', 'ops:read'],
    ['GET', '/api/v1/ops/trace/verify', 'ops:read'],
  ] as const;
  it.each(PATHS)('%s %s is registered with scope %s', (method, path, scope) => {
    const r = V1_ROUTES.find((x) => x.method === method && x.path === path);
    expect(r).toBeDefined();
    expect(r!.scopes).toEqual([scope]);
    const doc = buildOpenApiV1() as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths[path]?.[method.toLowerCase()]).toBeDefined();
  });
  it('docs/api/openapi-v1.json is the emitted file', () => {
    const file = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../docs/api/openapi-v1.json', import.meta.url)),
        'utf8',
      ),
    ) as { paths: Record<string, unknown> };
    for (const [, path] of PATHS) expect(file.paths[path]).toBeDefined();
  });
  it('an entry has exactly the contract fields', () => {
    expect(Object.keys(TimelineEntrySchema.shape).sort()).toEqual([
      'actor',
      'amount_minor',
      'at',
      'channel',
      'event_type',
      'seq',
      'source',
      'state_from',
      'state_to',
      'verified',
      'words_key',
    ]);
  });
});
