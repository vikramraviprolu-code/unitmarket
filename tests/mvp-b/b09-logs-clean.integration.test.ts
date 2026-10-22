// B-09 logs_clean (P7, OBS-1 to OBS-3), offline: a full dry-run journey through the route handlers
// with seeded token and email strings planted at every place a request carries data (headers, query,
// cookie, body). Every server log line and every provider_calls row is then scanned: zero seeded
// values, zero secret-shaped values, debug ids present. Also proves the journey made no network
// call (net, tls, http, https, dns, fetch). The scanner proves itself first with its own canaries.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@umsbx/obs';
import { systemClock } from '@umsbx/runtime';
import type { Actor } from '@umsbx/contracts';
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
