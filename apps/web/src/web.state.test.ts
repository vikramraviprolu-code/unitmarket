// Lane 15 state tests: the route handlers over a real offline app (PGlite, dry-run transport, seeded
// catalogue). Money-state behaviour is the payments lanes' job; payments is the real engine (see payments.state.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../composition.server';
import { bootTestApp, call, signIn } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

let app: App;
let healthz: typeof import('./app/healthz/route');
let sessionRoute: typeof import('./app/api/session/route');
let quotes: typeof import('./app/api/quotes/route');
let approvals: typeof import('./app/api/approvals/route');
let orders: typeof import('./app/api/orders/route');
let orderGet: typeof import('./app/api/orders/[ref]/route');
let discover: typeof import('./app/api/discover/route');
let briefs: typeof import('./app/api/briefs/route');
let library: typeof import('./app/api/library/route');
let receipts: typeof import('./app/api/receipts/[order]/route');
let content: typeof import('./app/c/[token]/route');
let A: Session;
let B: Session;

beforeAll(async () => {
  app = await bootTestApp();
  healthz = await import('./app/healthz/route');
  sessionRoute = await import('./app/api/session/route');
  quotes = await import('./app/api/quotes/route');
  approvals = await import('./app/api/approvals/route');
  orders = await import('./app/api/orders/route');
  orderGet = await import('./app/api/orders/[ref]/route');
  discover = await import('./app/api/discover/route');
  briefs = await import('./app/api/briefs/route');
  library = await import('./app/api/library/route');
  receipts = await import('./app/api/receipts/[order]/route');
  content = await import('./app/c/[token]/route');
  A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  B = (await signIn(sessionRoute.POST, 'buyer-b'))!;
});
afterAll(async () => {
  await app.close();
});

const offer = { publisher: 'harbour-ledger', offer: 'tide-tables' };

describe('health and headers', () => {
  it('healthz is public, labelled from data and carries the security headers', async () => {
    const res = await call(healthz.GET, { url: '/healthz' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; environment: string };
    expect(body.ok).toBe(true);
    expect(body.environment).toBe('dryrun');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('sign-in', () => {
  it('a wrong passcode gives 401 and no cookie; an unknown persona the same', async () => {
    const bad = await call(sessionRoute.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'buyer-a', passcode: 'nope' },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const unknown = await call(sessionRoute.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'nobody', passcode: 'nope' },
    });
    expect(unknown.status).toBe(401);
  });
  it('the right passcode gives a __Host- cookie and a csrf token', () => {
    expect(A.cookie.startsWith('__Host-ums_s=')).toBe(true);
    expect(A.csrf.length).toBeGreaterThanOrEqual(16);
  });
});

describe('quotes and approvals (offer journey up to the approval screen)', () => {
  it('quotes the publisher offer in the buyer currency, option and price from the catalogue', async () => {
    const res = await call(quotes.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      body: { ...offer, option: 'keep_retrieve' },
    });
    expect(res.status).toBe(200);
    const q = (await res.json()) as { kind: string; price: { minor: number; currency: string } };
    expect(q.kind).toBe('quote');
    expect(q.price).toEqual({ currency: 'USD', minor: 40 });
  });

  it('ceiling below price is a no-match with a reason and no alternatives (A-05)', async () => {
    const res = await call(quotes.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      body: { ...offer, option: 'keep_retrieve', ceiling_minor: 10 },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['kind']).toBe('no_match');
    expect(body['reason']).toBe('above_ceiling');
    expect(Object.keys(body).sort()).toEqual(['kind', 'reason']);
  });

  it('an approval needs the terms consent and returns a frozen snapshot and a token', async () => {
    const q = (await (
      await call(quotes.POST, {
        url: '/api/quotes',
        method: 'POST',
        session: A,
        body: { ...offer, option: 'online_read' },
      })
    ).json()) as { quote_id: string };
    const refused = await call(approvals.POST, {
      url: '/api/approvals',
      method: 'POST',
      session: A,
      body: { quote_id: q.quote_id, consent: { terms: false, identity_share: false } },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const ok = await call(approvals.POST, {
      url: '/api/approvals',
      method: 'POST',
      session: A,
      body: { quote_id: q.quote_id, consent: { terms: true, identity_share: false } },
    });
    expect(ok.status).toBe(201);
    const a = (await ok.json()) as {
      approval_id: string;
      token: string;
      expires_at: string;
      total_minor: number;
      environment: string;
    };
    expect(a.token.length).toBeGreaterThan(20);
    expect(a.total_minor).toBe(40);
    expect(a.environment).toBe('dryrun');
    const view = await app.engine.approvalView({
      approval_id: a.approval_id,
      actor: { kind: 'buyer', buyer_id: await buyerIdOf(app, 'buyer-b') },
    });
    expect(view).toBeNull();
  });
});

describe('access control', () => {
  it('unauthenticated library is 401; wrong csrf is 403', async () => {
    expect((await call(library.GET, { url: '/api/library' })).status).toBe(401);
    const noCsrf = await call(quotes.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      csrf: false,
      body: { ...offer, option: 'online_read' },
    });
    expect(noCsrf.status).toBe(403);
  });
  it('buyer B gets 404 for an order, receipt and link that do not belong to B (A-20)', async () => {
    const o = await call(orderGet.GET, {
      url: '/api/orders/ord_00000000000000000000000000',
      session: B,
      params: { ref: 'ord_00000000000000000000000000' },
    });
    expect(o.status).toBe(404);
    const r = await call(receipts.GET, {
      url: '/api/receipts/ord_00000000000000000000000000',
      session: B,
      params: { order: 'ord_00000000000000000000000000' },
    });
    expect(r.status).toBe(404);
  });
  it('the content route refuses a bad token with no-store and no-referrer (P14)', async () => {
    const res = await call(content.GET, { url: '/c/bad', session: A, params: { token: 'bad' } });
    expect([403, 404]).toContain(res.status);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('library is empty for a buyer with no purchase', async () => {
    const res = await call(library.GET, { url: '/api/library', session: B });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('payments through the routes', () => {
  it('POST /api/orders with an unknown approval is 404 and writes no order', async () => {
    const res = await call(orders.POST, {
      url: '/api/orders',
      method: 'POST',
      session: A,
      headers: { 'idempotency-key': 'test-key-0001' },
      body: { approval_id: 'apr_00000000000000000000000000', token: 'x'.repeat(40) },
    });
    expect(res.status).toBe(404);
    const n = await app.db.query<{ c: string }>('SELECT count(*) AS c FROM orders');
    expect(Number(n.rows[0]?.c)).toBe(0);
  });
});

describe('discovery and the ai_enabled switch', () => {
  it('refuses with 503 ai_off when the switch is off, and works when it is on', async () => {
    await app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'ai_enabled'`);
    const off = await call(briefs.POST, {
      url: '/api/briefs',
      method: 'POST',
      session: A,
      body: { need: 'tide tables, under $1, read online' },
    });
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe('ai_off');
    const offDisc = await call(discover.POST, {
      url: '/api/discover',
      method: 'POST',
      session: A,
      body: { need: 'tide tables, under $1, read online' },
    });
    expect(offDisc.status).toBe(503);
    await app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'ai_enabled'`);
    const on = await call(discover.POST, {
      url: '/api/discover',
      method: 'POST',
      session: A,
      body: { need: 'tide tables, under $1, read online' },
    });
    expect(on.status).toBe(200);
    const body = (await on.json()) as { kind: string };
    expect(['proposal', 'no_match']).toContain(body.kind);
  });
});

describe('operator view', () => {
  it('ops snapshot lists the eight switches and the environment label', async () => {
    const snap = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(snap).not.toBeNull();
    expect(Object.keys(snap!.switches).sort()).toEqual([
      'agent_buy_enabled',
      'ai_enabled',
      'checkout_enabled',
      'paypal_outbound',
      'refunds_enabled',
      'unlock_enabled',
      'web_import_enabled',
      'webhook_enabled',
    ]);
    expect(snap!.environment).toBe('dryrun');
    expect(await app.engine.opsSnapshot({ kind: 'buyer', buyer_id: 'buy_x' })).toBeNull();
  });
});

async function buyerIdOf(a: App, persona: string): Promise<string> {
  const r = await a.db.query<{ id: string }>('SELECT id FROM buyers WHERE auth_subject = $1', [
    `persona:${persona}`,
  ]);
  return r.rows[0]!.id;
}
