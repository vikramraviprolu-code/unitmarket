// MVP-A acceptance through the web app's HTTP route handlers (lane 15b composition, dry run):
// A-01 boot, A-02 no socket, A-20 buyer isolation over HTTP, A-22 labels in the JSON the screens
// render, and the PERF-2 offline twin (quote and approval API p95 under 300 ms over 200 requests).
// Offline only. The app runs on the real clock, so nothing here depends on time passing.
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { createApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { bootTestApp, call, signIn, testEnv } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';

vi.mock('server-only', () => ({}));

type Handler = Parameters<typeof call>[0];
let app: App;
let routes: {
  session: { POST: Handler };
  quotes: { POST: Handler };
  approvals: { POST: Handler };
  orders: { POST: Handler };
  order: { GET: Handler };
  checkout: { POST: Handler };
  cases: { POST: Handler };
  link: { POST: Handler };
  receipt: { GET: Handler };
  library: { GET: Handler };
  health: { GET: Handler };
};
let A: Session;
let B: Session;
let actorA: Actor;
const spies: ReturnType<typeof vi.spyOn>[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  spies.push(
    vi.spyOn(net, 'connect'),
    vi.spyOn(net, 'createConnection'),
    vi.spyOn(net.Socket.prototype, 'connect'),
    vi.spyOn(tls, 'connect'),
  );
  app = await bootTestApp();
  routes = {
    session: await import('../../apps/web/src/app/api/session/route'),
    quotes: await import('../../apps/web/src/app/api/quotes/route'),
    approvals: await import('../../apps/web/src/app/api/approvals/route'),
    orders: await import('../../apps/web/src/app/api/orders/route'),
    order: await import('../../apps/web/src/app/api/orders/[ref]/route'),
    checkout: await import('../../apps/web/src/app/api/orders/[ref]/checkout/route'),
    cases: await import('../../apps/web/src/app/api/cases/route'),
    link: await import('../../apps/web/src/app/api/library/[id]/link/route'),
    receipt: await import('../../apps/web/src/app/api/receipts/[order]/route'),
    library: await import('../../apps/web/src/app/api/library/route'),
    health: await import('../../apps/web/src/app/healthz/route'),
  } as never;
  A = (await signIn(routes.session.POST, 'buyer-a'))!;
  B = (await signIn(routes.session.POST, 'buyer-b'))!;
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actorA = { kind: 'buyer', buyer_id: row.rows[0]!.id };
});
afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function journeyA(code = 'tide-tables') {
  const q = await call(routes.quotes.POST, {
    url: '/api/quotes',
    method: 'POST',
    session: A,
    body: { publisher: 'harbour-ledger', offer: code, option: 'keep_retrieve' },
  });
  expect(q.status).toBe(200);
  const quote = await json(q);
  const g = await call(routes.approvals.POST, {
    url: '/api/approvals',
    method: 'POST',
    session: A,
    body: { quote_id: quote.quote_id, consent: { terms: true, identity_share: false } },
  });
  expect(g.status).toBe(201);
  const grant = await json(g);
  const placed = await call(routes.orders.POST, {
    url: '/api/orders',
    method: 'POST',
    session: A,
    headers: { 'idempotency-key': `gate-key-${code}-0001` },
    body: { approval_id: grant.approval_id, token: grant.token },
  });
  expect(placed.status).toBe(201);
  const order = (await json(placed)) as { order_id: string; order_ref: string };
  const co = await call(routes.checkout.POST, {
    url: `/api/orders/${order.order_ref}/checkout`,
    method: 'POST',
    session: A,
    params: { ref: order.order_ref },
    body: {},
  });
  expect(co.status).toBe(200);
  expect(await app.engine.dryRunApprove({ order_ref: order.order_ref, actor: actorA, scenario: 'happy' })).toBe(true);
  const ret = await app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor: actorA, scenario: 'happy' });
  expect(ret.ok).toBe(true);
  return { ...order, grant };
}

describe('A-01 boot_refuses_live (the app)', () => {
  it('the app composition throws before it can listen when the mode is live', async () => {
    const env = await testEnv({ UMS_MODE: 'live' });
    expect(() => createApp(env)).toThrow(/boot refused: live_not_available/);
    const env2 = await testEnv({ UMS_MODE: 'production' });
    expect(() => createApp(env2)).toThrow(/boot refused/);
    const host = ['api-m', 'paypal', 'com'].join('.');
    const env3 = await testEnv({ SOMETHING: `https://${host}` });
    expect(() => createApp(env3)).toThrow(/boot refused: non_sandbox_host/);
  });
});

describe('A-20 buyer_isolation over HTTP', () => {
  it("buyer B asking for buyer A's order, entitlement link, receipt or case by id gets 404", async () => {
    const mine = await journeyA();
    const ent = await app.db.query<{ id: string }>(
      `SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
      [mine.order_id],
    );
    const entId = ent.rows[0]!.id;
    // control: A can reach all of them
    expect((await call(routes.order.GET, { url: `/api/orders/${mine.order_ref}`, session: A, params: { ref: mine.order_ref } })).status).toBe(200);
    expect((await call(routes.receipt.GET, { url: `/api/receipts/${mine.order_id}`, session: A, params: { order: mine.order_id } })).status).toBe(200);
    expect((await call(routes.link.POST, { url: `/api/library/${entId}/link`, method: 'POST', session: A, params: { id: entId }, body: {} })).status).toBe(200);

    const asB = {
      order: await call(routes.order.GET, { url: `/api/orders/${mine.order_ref}`, session: B, params: { ref: mine.order_ref } }),
      checkout: await call(routes.checkout.POST, { url: `/api/orders/${mine.order_ref}/checkout`, method: 'POST', session: B, params: { ref: mine.order_ref }, body: {} }),
      receipt: await call(routes.receipt.GET, { url: `/api/receipts/${mine.order_id}`, session: B, params: { order: mine.order_id } }),
      link: await call(routes.link.POST, { url: `/api/library/${entId}/link`, method: 'POST', session: B, params: { id: entId }, body: {} }),
      caseByOrder: await call(routes.cases.POST, { url: '/api/cases', method: 'POST', session: B, body: { order_id: mine.order_id } }),
      caseByEnt: await call(routes.cases.POST, { url: '/api/cases', method: 'POST', session: B, body: { entitlement_id: entId } }),
    };
    for (const [name, res] of Object.entries(asB)) {
      expect(res.status, `${name} for buyer B`).toBe(404);
    }
    // The answer for another buyer's id equals the answer for an id that does not exist (no oracle).
    const missing = await call(routes.order.GET, { url: '/api/orders/ord_nothing', session: B, params: { ref: 'ord_nothing' } });
    expect(missing.status).toBe(404);
    const strip = (b: Record<string, unknown>) => {
      const e = { ...(b.error as Record<string, unknown>) };
      delete e.support_code;
      return e;
    };
    expect(strip(await json(missing))).toEqual(strip(await json(asB.order)));
    const lib = await json(await call(routes.library.GET, { url: '/api/library', session: B }));
    expect(lib.items).toEqual([]);
  });

  it('a request with no session, a forged cookie or a missing CSRF token is refused', async () => {
    const anon = await call(routes.library.GET, { url: '/api/library' });
    expect([401, 403]).toContain(anon.status);
    const forged = await call(routes.library.GET, {
      url: '/api/library',
      session: { cookie: 'ums_session=ses_00000000000000000000000000.forged', csrf: 'x' },
    });
    expect([401, 403]).toContain(forged.status);
    const noCsrf = await call(routes.quotes.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      csrf: false,
      body: { publisher: 'harbour-ledger', offer: 'tide-tables' },
    });
    expect([401, 403]).toContain(noCsrf.status);
  });
});

describe('A-22 labels_from_data (the JSON the screens render)', () => {
  it('approval, order, library item, receipt and ops snapshot all carry the stored dry-run label', async () => {
    const mine = await journeyA('ferry-timetables');
    const approval = await app.engine.approvalView({ approval_id: mine.grant.approval_id as string, actor: actorA });
    expect(approval?.environment).toBe('dryrun');
    const view = await app.engine.orderView({ order_ref: mine.order_ref, actor: actorA });
    expect(view?.environment).toBe('dryrun');
    const lib = await app.engine.library({ actor: actorA });
    expect(lib.length).toBeGreaterThan(0);
    expect(lib.every((l) => l.environment === 'dryrun')).toBe(true);
    const receipt = await app.engine.receipt({ order_id: mine.order_id, actor: actorA });
    expect(receipt?.environment).toBe('dryrun');
    expect(app.engine.receiptHtml(receipt!)).toContain('Dry run');
    const ops = await app.engine.opsSnapshot({ kind: 'operator', operator_id: 'opr_demo', mfa: false });
    expect(ops?.environment).toBe('dryrun');
    const health = await json(await call(routes.health.GET, { url: '/healthz' }));
    expect(health.environment).toBe('dryrun');
  });
});

describe('PERF-2 offline twin: quote and approval API p95 under 300 ms over 200 requests', () => {
  it('200 quote requests and 200 approval requests through the route handlers', async () => {
    const N = 200;
    const sessions: { cookie: string; csrf: string }[] = [];
    for (let i = 0; i < N; i += 1) {
      const id = `buy_perf${String(i).padStart(4, '0')}`;
      await app.db.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, 'Perf buyer', $2, 'US', now(), now())`,
        [id, `perf:${id}`],
      );
      const s = await createSession(app.security, { kind: 'buyer', buyer_id: id });
      sessions.push({ cookie: s.cookie.split(';')[0]!, csrf: s.csrf_token });
    }
    const quoteMs: number[] = [];
    const approvalMs: number[] = [];
    const codes = ['tide-tables', 'ferry-timetables', 'knot-notebook', 'harbour-fees'];
    for (let i = 0; i < N; i += 1) {
      const s = sessions[i]!;
      const t0 = process.hrtime.bigint();
      const q = await call(routes.quotes.POST, {
        url: '/api/quotes',
        method: 'POST',
        session: s,
        body: { publisher: 'harbour-ledger', offer: codes[i % codes.length], option: 'keep_retrieve' },
      });
      const t1 = process.hrtime.bigint();
      expect(q.status).toBe(200);
      const quote = await json(q);
      const g = await call(routes.approvals.POST, {
        url: '/api/approvals',
        method: 'POST',
        session: s,
        body: { quote_id: quote.quote_id, consent: { terms: true, identity_share: false } },
      });
      const t2 = process.hrtime.bigint();
      expect(g.status).toBe(201);
      quoteMs.push(Number(t1 - t0) / 1e6);
      approvalMs.push(Number(t2 - t1) / 1e6);
    }
    const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]!;
    const line = `PERF2 n=${N} quote p50=${p(quoteMs, 0.5).toFixed(1)}ms p95=${p(quoteMs, 0.95).toFixed(1)}ms max=${Math.max(...quoteMs).toFixed(1)}ms; approval p50=${p(approvalMs, 0.5).toFixed(1)}ms p95=${p(approvalMs, 0.95).toFixed(1)}ms max=${Math.max(...approvalMs).toFixed(1)}ms`;
    console.log(line);
    expect(p(quoteMs, 0.95)).toBeLessThan(300);
    expect(p(approvalMs, 0.95)).toBeLessThan(300);
  }, 120_000);
});

describe('A-02 offline_opens_no_socket (the app)', () => {
  it('the whole HTTP journey above made no fetch, net.connect or tls.connect call', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
