// BU-2 acceptance (integration): the single-publisher journey through createApp in sandbox mode with
// a fake Wire playing PayPal (the dry-run order model behind a Wire-shaped adapter). Real scoped gate
// over the app's in-memory database with a real approval row (in-memory only), the real approved
// transport, the real PayPal adapter and the real job loop. No byte leaves the process: the
// production Wire is never built, and net, tls, http, https, dns and fetch are traced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@umsbx/runtime';
import type { Actor, OutboundRequest } from '@umsbx/contracts';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { createDryRunModel } from '../../apps/web/src/server/dryrun-model';
import { countDebugIds, scanLines, scanRows } from '../../scripts/log-scan.mjs';
import {
  FAKE_ID,
  FAKE_SECRET,
  REF,
  insertApproval,
  sandboxEnv,
  setOutboundSwitch,
} from './unseal-support';

vi.mock('server-only', () => ({}));

const { trace, patchModule } = vi.hoisted(() => {
  const trace = { calls: [] as string[] };
  type Fn = (...a: unknown[]) => unknown;
  const patchModule = (names: string[]) => async (importOriginal: () => Promise<unknown>) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    const patched: Record<string, unknown> = { ...actual };
    for (const name of names) {
      patched[name] = (...a: unknown[]) => {
        trace.calls.push(name);
        return (actual[name] as Fn)(...a);
      };
    }
    return { ...patched, default: patched };
  };
  return { trace, patchModule };
});
vi.mock('node:net', patchModule(['connect', 'createConnection']));
vi.mock('node:tls', patchModule(['connect']));
vi.mock('node:http', patchModule(['request', 'get']));
vi.mock('node:https', patchModule(['request', 'get']));
vi.mock('node:dns', patchModule(['lookup', 'resolve', 'resolve4', 'resolve6']));

const part = (...xs: string[]): string => xs.join('');
const SEED_TOKEN = part('seedtok', '-', 'bu2canary', '-', 'c0ffee42');
const SEED_EMAIL = part('seeded.buyer', '@', 'bu2-canary', '.example');
const SEED_PAYER = part('payer.seed', '@', 'bu2-canary', '.example');
const BASIC = Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64');
const SEEDS = [SEED_TOKEN, SEED_EMAIL, SEED_PAYER, FAKE_ID, FAKE_SECRET, BASIC];

interface PlayedCall {
  method: string;
  path: string;
  operation: string;
}
// The body text of every create the fake Wire saw (BU-7: the payee must be absent).
let sentBodies: { operation: string; body: string }[] = [];

/** A Wire that plays PayPal with the dry-run order model. Nothing here opens a socket. */
function paypalWire(model: ReturnType<typeof createDryRunModel>) {
  const played: PlayedCall[] = [];
  const reply = (status: number, body: unknown): WireResult => ({
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': `bu2dbg${played.length}` },
    body: JSON.stringify(body),
  });
  const wire: Wire = {
    async request(r: WireRequest): Promise<WireResult> {
      const path = new URL(r.url).pathname;
      if (r.method === 'POST' && path === '/v1/oauth2/token') {
        played.push({ method: r.method, path, operation: 'oauth_token' });
        return reply(200, { access_token: SEED_TOKEN, token_type: 'Bearer', expires_in: 32400 });
      }
      const operation =
        r.method === 'POST' && path === '/v2/checkout/orders'
          ? 'create_order'
          : r.method === 'GET' && path.startsWith('/v2/checkout/orders/')
            ? 'get_order'
            : r.method === 'POST' && path.endsWith('/capture')
              ? 'capture_order'
              : r.method === 'GET' && path.startsWith('/v2/payments/captures/')
                ? 'get_capture'
                : 'unknown';
      played.push({ method: r.method, path, operation });
      sentBodies.push({ operation, body: typeof r.body === 'string' ? r.body : '' });
      if (operation === 'unknown') return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      const out = model.send({
        operation,
        method: r.method,
        path,
        headers: r.headers,
        body: r.body,
        order_ref: null,
        amount_minor: null,
        scenario: null,
      } as OutboundRequest);
      if (out.kind === 'timeout') return { kind: 'error', error: 'timeout' };
      if (out.kind !== 'response') return { kind: 'error', error: 'other' };
      // PayPal puts the payer's personal data in its answers; the app must not log or store it.
      let body = out.body;
      try {
        const j = JSON.parse(body) as Record<string, unknown>;
        if (Array.isArray(j['purchase_units']))
          body = JSON.stringify({
            ...j,
            payer: {
              email_address: SEED_PAYER,
              payer_id: 'SEEDPAYERID',
              name: { given_name: 'Seed' },
            },
          });
      } catch {
        /* keep the body as it is */
      }
      return { kind: 'response', status: out.status, headers: out.headers, body };
    },
  };
  return { wire, played };
}

let app: App;
let actor: Actor;
let lines: string[];
let model: ReturnType<typeof createDryRunModel>;
let played: PlayedCall[];

async function boot(
  over: Record<string, string> = {},
  approvalOver: Parameters<typeof insertApproval>[1] = {},
) {
  lines = [];
  sentBodies = [];
  // BU-7: the order model answers for our own account the way PayPal does, with the own merchant id
  // as payee when the create body names none.
  const own = over['UMS_OWN_MERCHANT_ID'] ?? null;
  model = createDryRunModel(systemClock(), { own_merchant_id: own });
  const pw = paypalWire(model);
  played = pw.played;
  app = createApp(await sandboxEnv(over), {
    switch_cache_ms: 0,
    log_sink: (l) => lines.push(l),
    test_wire: pw.wire,
  });
  installApp(app);
  await app.ready();
  await insertApproval(app.db, {
    ref: REF,
    scope: over['UMS_OUTBOUND_SCOPE'] ?? 'mvp_b_polling',
    valid_until: '2999-01-01T00:00:00Z',
    max_calls: 300,
    max_amount_minor: 2000,
    ...approvalOver,
  });
  await setOutboundSwitch(app.db, true);
  const at = systemClock().now().toISOString();
  await app.db.query(
    `UPDATE publishers SET paypal_merchant_id = 'SBXM' || upper(left(md5(slug), 9)), payee_verified_at = $1`,
    [at],
  );
  if (own !== null) {
    await app.db.query(
      `UPDATE publishers SET paypal_merchant_id = $1 WHERE slug = 'harbour-ledger'`,
      [own],
    );
  }
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actor = { kind: 'buyer', buyer_id: row.rows[0]!.id };
  await app.db.query(`UPDATE buyers SET display_name = $2 WHERE id = $1`, [
    row.rows[0]!.id,
    SEED_EMAIL,
  ]);
}

async function placeOrder(): Promise<{ order_ref: string; order_id: string }> {
  const offers = (await app.engine.listOffers()).filter(
    (o) => o.publisher_slug === 'harbour-ledger',
  );
  const offer = offers[0]!.offer_code;
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
    actor,
    source: 'direct',
    option: page!.options[0]!.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error('no approval');
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error(`place failed: ${placed.error.code}`);
  return placed.value;
}

async function providerOrderId(order_id: string): Promise<string> {
  const r = await app.db.query<{ provider_order_id: string }>(
    'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
    [order_id],
  );
  return r.rows[0]!.provider_order_id;
}
const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await app.db.query<{ c: string }>(sql, p)).rows[0]?.c);
const statusOf = async (ref: string): Promise<string | undefined> =>
  (await app.engine.orderView({ order_ref: ref, actor }))?.status;
const ops = (): string[] => played.map((p) => p.operation);

beforeEach(() => {
  trace.calls.length = 0;
  vi.stubGlobal('fetch', (...a: unknown[]) => {
    trace.calls.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('fetch is not available in the offline journey'));
  });
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe('the sandbox journey over a fake Wire (mvp_c_refunds scope: the order names its payee)', () => {
  it('a happy order: create, approve, return captures; at most 6 Wire calls (B-08); no seed in any log line or provider_calls row (B-09)', async () => {
    await boot({ UMS_OUTBOUND_SCOPE: 'mvp_c_refunds' });
    const order = await placeOrder();
    const co = await app.engine.payments.beginCheckout({ order_id: order.order_id, actor });
    expect(co.ok).toBe(true);
    expect(model.approve(await providerOrderId(order.order_id), 'happy')).toBe(true);
    const back = await app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor });
    expect(back.ok).toBe(true);
    expect(await statusOf(order.order_ref)).toBe('paid');

    expect(played.length).toBeLessThanOrEqual(6);
    expect(ops().filter((o) => o === 'create_order')).toHaveLength(1);
    expect(ops().filter((o) => o === 'capture_order')).toHaveLength(1);
    expect(ops().filter((o) => o === 'oauth_token')).toHaveLength(1);
    // The item is unlocked exactly once: one sale, one capture id, one entitlement.
    expect(
      await count(
        "SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'",
        [order.order_id],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(DISTINCT capture_id) AS c FROM order_units WHERE order_id = $1', [
        order.order_id,
      ]),
    ).toBe(1);
    // Every call went through the gate: one reservation per Wire call.
    expect(await count(`SELECT count(*) AS c FROM audit_log WHERE action = 'gate.reserve'`)).toBe(
      played.length,
    );

    const rows = (
      await app.db.query<Record<string, unknown>>(
        'SELECT * FROM provider_calls ORDER BY created_at',
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r['transport_kind'] === 'sandbox')).toBe(true);
    expect(rows.every((r) => r['environment'] === 'sandbox')).toBe(true);
    expect(scanLines(lines, { seeds: SEEDS, label: 'log' })).toEqual([]);
    expect(scanRows(rows, { seeds: SEEDS, label: 'row' })).toEqual([]);
    const answered = rows.filter((r) => typeof r['http_status'] === 'number');
    expect(countDebugIds(answered as { debug_id?: unknown }[])).toBe(answered.length);
    expect(lines.some((l) => l.includes('sandbox.send'))).toBe(true);
    expect(trace.calls).toEqual([]);
  }, 60_000);

  it('capture times out, the job loop read-back resolves it: one capture, one sale, item unlocked once', async () => {
    await boot({ UMS_OUTBOUND_SCOPE: 'mvp_c_refunds' });
    const order = await placeOrder();
    expect((await app.engine.payments.beginCheckout({ order_id: order.order_id, actor })).ok).toBe(
      true,
    );
    expect(model.approve(await providerOrderId(order.order_id), 'lost_capture_response')).toBe(
      true,
    );
    await app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor });
    expect(await statusOf(order.order_ref)).not.toBe('paid');
    expect(ops().filter((o) => o === 'capture_order')).toHaveLength(1);

    await app.db.query(
      `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE state = 'unknown'`,
    );
    const jobs = await app.startJobs();
    await vi.waitFor(async () => expect(await statusOf(order.order_ref)).toBe('paid'), {
      timeout: 25_000,
      interval: 200,
    });
    await jobs.stop();

    expect(ops().filter((o) => o === 'capture_order')).toHaveLength(1);
    expect(ops().filter((o) => o === 'get_order').length).toBeGreaterThanOrEqual(1);
    expect(played.length).toBeLessThanOrEqual(8);
    expect(
      await count(
        "SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'",
        [order.order_id],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(DISTINCT capture_id) AS c FROM order_units WHERE order_id = $1', [
        order.order_id,
      ]),
    ).toBe(1);
    const rows = (await app.db.query<Record<string, unknown>>('SELECT * FROM provider_calls')).rows;
    expect(scanLines(lines, { seeds: SEEDS, label: 'log' })).toEqual([]);
    expect(scanRows(rows, { seeds: SEEDS, label: 'row' })).toEqual([]);
    expect(trace.calls).toEqual([]);
  }, 90_000);

  it('the loop works inside the budget: the call allowance read from the approval row never reads null in sandbox', async () => {
    await boot({ UMS_OUTBOUND_SCOPE: 'mvp_c_refunds' }, { max_calls: 40 });
    const jobs = await app.startJobs();
    await new Promise((r) => setTimeout(r, 400));
    await jobs.stop();
    expect(lines.some((l) => l.includes('jobs.loop.no_call_budget'))).toBe(false);
    expect(trace.calls).toEqual([]);
  }, 30_000);
});

describe('the default scope (mvp_b_polling) with our own merchant id (BU-7, D-028)', () => {
  // BU-7 spec change: this test was the "documented gap" for F1 (an order always names its payee and
  // mvp_b_polling refuses a payee, so create never reached the Wire). F1 is resolved by D-028 option
  // (c): the payee is left out of the body when it is our own merchant id. The gap test is replaced
  // by the journey below.
  const OWN = 'SBXOWNMERCH01';

  it('create reaches the Wire without a payee; approve, return captures; the read-back matches our own id; paid once', async () => {
    await boot({ UMS_OWN_MERCHANT_ID: OWN });
    const order = await placeOrder();
    const co = await app.engine.payments.beginCheckout({ order_id: order.order_id, actor });
    expect(co.ok).toBe(true);
    expect(ops()).toContain('create_order');
    expect(lines.some((l) => l.includes('payee_not_allowed'))).toBe(false);
    expect(model.approve(await providerOrderId(order.order_id), 'happy')).toBe(true);
    const back = await app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor });
    expect(back.ok).toBe(true);
    expect(await statusOf(order.order_ref)).toBe('paid');

    const create = sentBodies.find((b) => b.operation === 'create_order');
    expect(create?.body).toBeTruthy();
    expect(create?.body).not.toContain('payee');
    expect(create?.body).not.toContain(OWN);
    // the read-back compared the payee and found our own id
    expect(ops().filter((o) => o === 'create_order')).toHaveLength(1);
    expect(ops().filter((o) => o === 'capture_order')).toHaveLength(1);
    expect(played.length).toBeLessThanOrEqual(6);
    expect(
      await count(
        "SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'",
        [order.order_id],
      ),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS c FROM entitlements WHERE access_state = 'available'"),
    ).toBe(1);
    expect(await count(`SELECT count(*) AS c FROM audit_log WHERE action = 'gate.reserve'`)).toBe(
      played.length,
    );
    expect(trace.calls).toEqual([]);
  }, 60_000);

  it('own id unset: the same order still names its payee and create never reaches the Wire (fail closed)', async () => {
    await boot();
    const order = await placeOrder();
    const co = await app.engine.payments.beginCheckout({ order_id: order.order_id, actor });
    expect(co.ok).toBe(false);
    expect(ops()).not.toContain('create_order');
    expect(lines.some((l) => l.includes('payee_not_allowed'))).toBe(true);
    expect(trace.calls).toEqual([]);
  }, 60_000);
});
