// B-09 logs_clean (P7, OBS-1 to OBS-3), offline: a full dry-run journey through the route handlers
// with seeded token and email strings planted at every place a request carries data (headers, query,
// cookie, body). Every server log line and every provider_calls row is then scanned: zero seeded
// values, zero secret-shaped values, debug ids present. Also proves the journey made no network
// call (net, tls, http, https, dns, fetch). The scanner proves itself first with its own canaries.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@umsbx/obs';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, systemClock } from '@umsbx/runtime';
import { createScopedGate, createSwitchReader } from '@umsbx/safety';
import { createApprovedSandboxTransport } from '@umsbx/transport';
import type { Wire } from '@umsbx/transport';
import type { Actor, LogEvent, Logger, OutboundRequest } from '@umsbx/contracts';
import type { App } from '../../apps/web/composition.server';
import { call, signIn, testEnv, PASSCODE } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import { createApp, installApp } from '../../apps/web/composition.server';
import { countDebugIds, scanLines, scanRows, selfTest } from '../../scripts/log-scan.mjs';

vi.mock('server-only', () => ({}));

// Network trace: every entry point that could open a connection is wrapped, counted, and passed on.
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

// Seeds are built at run time. None is a real credential; the shapes are what a leak would look like.
const part = (...xs: string[]): string => xs.join('');
const SEED_TOKEN = part('seedtok', '-', 'b09canary', '-', 'c0ffee42');
const SEED_BEARER = part('b09bearer', 'seed', 'Zk82', 'qLm4Xp91');
const SEED_EMAIL = part('seeded.buyer', '@', 'b09-canary', '.example');
const SEED_PAYER_EMAIL = part('payer.seed', '@', 'b09-canary', '.example');
const SEEDS = [SEED_TOKEN, SEED_BEARER, SEED_EMAIL, SEED_PAYER_EMAIL, PASSCODE];

type Handler = Parameters<typeof call>[0];
const lines: string[] = [];
let app: App;
let routes: {
  session: { POST: Handler };
  quotes: { POST: Handler };
  approvals: { POST: Handler };
  orders: { POST: Handler };
  checkout: { POST: Handler };
  order: { GET: Handler };
};
let S: Session;
let actor: Actor;
let providerRows: Record<string, unknown>[];
let approvalToken = '';

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeAll(async () => {
  vi.stubGlobal('fetch', (...a: unknown[]) => {
    trace.calls.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('fetch is not available in the offline gate'));
  });
  app = createApp(await testEnv(), { switch_cache_ms: 0, log_sink: (l) => lines.push(l) });
  installApp(app);
  await app.ready();
  routes = {
    session: await import('../../apps/web/src/app/api/session/route'),
    quotes: await import('../../apps/web/src/app/api/quotes/route'),
    approvals: await import('../../apps/web/src/app/api/approvals/route'),
    orders: await import('../../apps/web/src/app/api/orders/route'),
    checkout: await import('../../apps/web/src/app/api/orders/[ref]/checkout/route'),
    order: await import('../../apps/web/src/app/api/orders/[ref]/route'),
  } as never;
  S = (await signIn(routes.session.POST, 'buyer-a'))!;
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actor = { kind: 'buyer', buyer_id: row.rows[0]!.id };
  // Personal data in the database the journey reads: the buyer's display name carries an email.
  await app.db.query(`UPDATE buyers SET display_name = $2 WHERE id = $1`, [
    actor.kind === 'buyer' ? actor.buyer_id : '',
    SEED_EMAIL,
  ]);

  // Planted at the edge of every request: an Authorization header, a query string, a custom header.
  const planted = {
    authorization: `Bearer ${SEED_BEARER}`,
    'x-seed-token': SEED_TOKEN,
    'x-forwarded-for': '203.0.113.7',
  };
  const q = await call(routes.quotes.POST, {
    url: `/api/quotes?email=${encodeURIComponent(SEED_EMAIL)}&token=${SEED_TOKEN}`,
    method: 'POST',
    session: S,
    headers: planted,
    body: { publisher: 'harbour-ledger', offer: 'tide-tables', option: 'keep_retrieve' },
  });
  expect(q.status).toBe(200);
  const quote = await json(q);
  const g = await call(routes.approvals.POST, {
    url: `/api/approvals?payer=${encodeURIComponent(SEED_PAYER_EMAIL)}`,
    method: 'POST',
    session: S,
    headers: planted,
    body: { quote_id: quote.quote_id, consent: { terms: true, identity_share: false } },
  });
  expect(g.status).toBe(201);
  const grant = await json(g);
  approvalToken = String(grant.token);
  const placed = await call(routes.orders.POST, {
    url: '/api/orders',
    method: 'POST',
    session: S,
    headers: { ...planted, 'idempotency-key': 'b09-key-0001' },
    body: { approval_id: grant.approval_id, token: grant.token },
  });
  expect(placed.status).toBe(201);
  const order = (await json(placed)) as { order_id: string; order_ref: string };
  const co = await call(routes.checkout.POST, {
    url: `/api/orders/${order.order_ref}/checkout`,
    method: 'POST',
    session: S,
    headers: planted,
    params: { ref: order.order_ref },
    body: {},
  });
  expect(co.status).toBe(200);
  expect(
    await app.engine.dryRunApprove({ order_ref: order.order_ref, actor, scenario: 'happy' }),
  ).toBe(true);
  const ret = await app.engine.payments.onBuyerReturn({
    order_ref: order.order_ref,
    actor,
    scenario: 'happy',
  });
  expect(ret.ok).toBe(true);
  // A failing request too: error paths log as well.
  await call(routes.order.GET, {
    url: `/api/orders/ord_missing?email=${SEED_EMAIL}`,
    session: S,
    headers: planted,
    params: { ref: 'ord_missing' },
  });
  providerRows = (
    await app.db.query<Record<string, unknown>>(`SELECT * FROM provider_calls ORDER BY created_at`)
  ).rows;
}, 60_000);

afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe('B-09 logs_clean', () => {
  it('the scanner finds its own canaries before it is trusted (seeded-canary self-test)', () => {
    expect(selfTest()).toEqual({ ok: true, missed: [], false_alarms: [] });
  });

  it('the journey produced log lines and provider_calls rows to scan', () => {
    expect(lines.length).toBeGreaterThan(3);
    expect(providerRows.length).toBeGreaterThanOrEqual(3);
    // The approval token is a runtime secret too: it must not appear either.
    expect(approvalToken.length).toBeGreaterThan(16);
  });

  it('zero seeded or secret-shaped values in every log line', () => {
    const findings = scanLines(lines, { seeds: [...SEEDS, approvalToken], label: 'log' });
    expect(findings).toEqual([]);
  });

  it('zero seeded or secret-shaped values in every provider_calls row', () => {
    const findings = scanRows(providerRows, { seeds: [...SEEDS, approvalToken], label: 'row' });
    expect(findings).toEqual([]);
  });

  it('a planted seed in a log line or a row would be caught (the scan is not vacuous here)', () => {
    expect(scanLines([...lines, `leak ${SEED_TOKEN}`], { seeds: SEEDS }).length).toBe(1);
    expect(
      scanRows([...providerRows, { note: SEED_EMAIL }], { seeds: SEEDS }).length,
    ).toBeGreaterThan(0);
  });

  it('debug ids are present on every provider call that got an answer (OBS-1, OBS-3)', () => {
    const answered = providerRows.filter((r) => typeof r.http_status === 'number');
    expect(answered.length).toBeGreaterThanOrEqual(3);
    expect(countDebugIds(answered as { debug_id?: unknown }[])).toBe(answered.length);
  });

  it('every log line is one JSON object with a level and a message (OBS-1 shape)', () => {
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.every((p) => typeof p.msg === 'string' && typeof p.level === 'string')).toBe(
      true,
    );
  });

  it('the production logger: seeds in keyed fields, free text and nested data never reach the sink; debug and request ids stay', () => {
    const out: string[] = [];
    const log = createLogger((l) => out.push(l), { env_label: 'dryrun' }, systemClock());
    const nested = {
      headers: { authorization: `Bearer ${SEED_BEARER}`, cookie: `sid=${SEED_TOKEN}` },
    };
    log.log({
      msg: `capture failed for ${SEED_EMAIL}`,
      level: 'error',
      fields: {
        request_id: 'req_b09_0001',
        order_ref: 'ord_b09_0001',
        paypal_debug_id: 'dbg1234567890ab',
        access_token: SEED_TOKEN,
        client_secret: SEED_BEARER,
        email: SEED_EMAIL,
        payer: JSON.stringify({ email_address: SEED_PAYER_EMAIL, name: 'Seed Payer' }),
        note: `retry for ${SEED_PAYER_EMAIL} with Bearer ${SEED_BEARER}`,
        raw: JSON.stringify(nested),
        nested: JSON.stringify(nested),
      },
    });
    log.child({ request_id: 'req_b09_0002' }).log({
      msg: 'child line',
      level: 'warn',
      fields: {
        refresh_token: SEED_TOKEN,
        url: `https://example.test/cb?token=${SEED_TOKEN}&email=${SEED_EMAIL}`,
      },
    });
    expect(out).toHaveLength(2);
    expect(scanLines(out, { seeds: SEEDS.filter((x) => x !== PASSCODE), label: 'logger' })).toEqual(
      [],
    );
    const first = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(first.paypal_debug_id).toBe('dbg1234567890ab');
    expect(first.request_id).toBe('req_b09_0001');
    expect(first.order_ref).toBe('ord_b09_0001');
    expect(JSON.parse(out[1]!).request_id).toBe('req_b09_0002');
  });

  it('the whole journey made no network call: no net, tls, http, https, dns or fetch', () => {
    expect(trace.calls).toEqual([]);
  });
});

const OBS_SEED_BEARER = part('tok-seed-', 'abcdef', '123456');
const OBS_SEED_BODY = part('tok-body-', 'secret-', '123456');
const OBS_SEED_BASIC = part('Zm9vOmJh', 'cjEyMzQ1', 'Njc4OQ');

function sandboxLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const make = (base: LogEvent['fields']): Logger => ({
    log: (e) => void events.push({ ...e, fields: { ...base, ...e.fields } }),
    child: (f) => make({ ...base, ...f }),
  });
  return Object.assign(make({}), { events });
}
const obsWire: Wire = {
  async request() {
    return {
      kind: 'response',
      status: 200,
      headers: { 'paypal-debug-id': 'dbg0123abc', 'set-cookie': 'sid=cookie-value-12345' },
      body: JSON.stringify({ access_token: OBS_SEED_BODY }),
    };
  },
};
const obsBase: Omit<OutboundRequest, 'operation' | 'method' | 'path' | 'headers' | 'body'> = {
  order_ref: null,
  amount_minor: null,
  scenario: null,
};

describe('FIX-BPREP OBS: sandbox.send log lines', () => {
  it('carry the debug id, request id, approval ref and a correlation id, and no secret', async () => {
    const log = sandboxLogger();
    // FIX-MVPB-SEAL2 H1: the capability comes from the real scoped gate over an in-memory database
    // with a real approval row; no fake gate can be minted into one any more.
    const REF = 'DL-2026-10-22-01';
    const T0 = '2026-10-22T10:00:00Z';
    const clock = fakeClock(T0);
    const db = await openDatabase({ kind: 'pglite-memory' });
    try {
      await migrate(db, clock);
      await db.query(
        `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
         VALUES ('oap_b09_obs',$1,'mvp_b_polling',$2,2000,100,'2026-10-23T00:00:00Z','owner',$3,$3)`,
        [REF, ['oauth_token', 'get_order'], T0],
      );
      await db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
      const gate = createScopedGate(db, clock, {
        scope: 'mvp_b_polling',
        switches: createSwitchReader(db, clock, 0),
        config: { mode: 'sandbox', connect: true, outbound_approval_ref: REF },
      });
      const approval = await gate.approvalCapability();
      expect(approval).not.toBeNull();
      const t = await createApprovedSandboxTransport({
        approval: approval!,
        scope: 'mvp_b_polling',
        clock,
        log,
        wire: obsWire,
      });
      await t.send({
        ...obsBase,
        operation: 'oauth_token',
        method: 'POST',
        path: '/v1/oauth2/token',
        headers: { authorization: `Basic ${OBS_SEED_BASIC}`, 'paypal-request-id': 'umsC-req-1' },
        body: 'grant_type=client_credentials',
      });
      await t.send({
        ...obsBase,
        operation: 'get_order',
        method: 'GET',
        path: '/v2/checkout/orders/ABC123',
        headers: { authorization: `Bearer ${OBS_SEED_BEARER}` },
        body: null,
      });
      const sends = log.events.filter((e) => e.msg === 'sandbox.send');
      expect(sends).toHaveLength(2);
      for (const e of sends) {
        expect(e.fields['approval_ref']).toBe('DL-2026-10-22-01');
        expect(e.fields['paypal_debug_id']).toBe('dbg0123abc');
        expect(typeof e.fields['correlation_id']).toBe('string');
      }
      expect(sends[0]?.fields['request_id']).toBe('umsC-req-1');
      const lines = log.events.map((e) => JSON.stringify(e));
      expect(scanLines(lines, { seeds: [OBS_SEED_BEARER, OBS_SEED_BODY, OBS_SEED_BASIC] })).toEqual(
        [],
      );
    } finally {
      await db.close();
    }
  });
});
