// API-W2 (item P1): the whole MVP 1 story as steps, told through the public routes only. Not a test file:
// e2e.integration.test.ts runs each step as one titled test, and offline.adversarial.test.ts runs the same
// steps again with every way to open a socket replaced by a function that records the call and throws.
//
// The story: a buyer signs in and gives an AI agent a key and a $5.00 cap; an operator with the second
// factor turns agent buying on; the buyer and the seller subscribe to events; the agent finds the tools and
// buys $0.10 units until the cap says stop; one delivery pass hands signed events to a sink that opens no
// socket; an operator without the second factor stops agent buying and the next purchase is refused.
//
// Rules of this file (spec docs/specs/api-w2-e2e.md): no product code is changed, nothing here reaches
// PayPal or any network (the app runs in dry-run over the order model; its webhook sender is an in-process
// sink), and every value is synthetic. The only helpers that touch the database directly are the seed of
// 60 cheap offers (extraOffers, the lane B support) and read-only counts for the evidence.
import { hashPasscode } from '@umsbx/security';
import type { App } from '../../apps/web/composition.server';
import { bootPackApp } from '../../apps/web/src/composite-support';
import { PASSCODE, call } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import { verifySignature } from '../../apps/web/src/api-v1/signature';
import { extraOffers, rows } from '../../apps/web/src/app/api/v1/mcp/agent-test-support';
import { VIKRAM_B32, totpCode } from '../mvp-c/c-support';
import { expect } from 'vitest';

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export const ORIGIN = 'http://localhost:3000';
export const PUBLISHER = 'harbour-ledger';
/** Passcode of the publisher personas. A synthetic value, different from the demo passcode on purpose. */
const PUBLISHER_PASSCODE = 'publisher passcode for the mvp1 story only';
export const CAP_MINOR = 500;
export const UNIT_MINOR = 10;
/** The count cap is looser than the money cap on purpose: the money cap is the one that stops the agent. */
export const COUNT_CAP = 60;
export const BOUGHT = CAP_MINOR / UNIT_MINOR;
const OFFER_COUNT = COUNT_CAP;
const BUYER_HOOK = 'https://buyer.example.com/hooks/unitmarket';
const SELLER_HOOK = 'https://seller.example.com/hooks/unitmarket';

export interface KeyPair {
  id: string;
  token: string;
}
export interface Rig {
  app: App;
  routes: Record<string, Handler>;
  /** Every /api/v1 route (method and path template) the story called, for the OpenAPI check. */
  used: Set<string>;
  buyer?: Session;
  operatorMfa?: Session;
  operatorNoMfa?: Session;
  seller?: Session;
  agent?: KeyPair;
  buyerClient?: KeyPair;
  sellerKey?: KeyPair;
  mandateId?: string;
  offers: string[];
  buyerSub?: { id: string; secret: string };
  sellerSub?: { id: string; secret: string };
  bought: string[];
  /** Number of orders in the store once the agent has bought (P1-06). */
  ordersAfterBuying?: number;
}

let counter = 0;
const idem = (p: string): string => `${p}-${String(++counter).padStart(6, '0')}-w2story`;

// ---------------------------------------------------------------------------------------------
// Boot and request helpers.
// ---------------------------------------------------------------------------------------------
export async function bootStory(): Promise<Rig> {
  const app = await bootPackApp({
    UMS_OPERATOR_TOTP_KEYS: `vikram:${VIKRAM_B32}`,
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(
      PUBLISHER_PASSCODE,
      '5a4b3c2d1e0f99887766554433221100',
    ),
  });
  const routes: Record<string, Handler> = {
    session: (await import('../../apps/web/src/app/api/session/route')).POST as Handler,
    apiKeysPost: (await import('../../apps/web/src/app/api/v1/api-keys/route')).POST as Handler,
    apiKeysGet: (await import('../../apps/web/src/app/api/v1/api-keys/route')).GET as Handler,
    mandates: (await import('../../apps/web/src/app/api/v1/mandates/route')).POST as Handler,
    mcp: (await import('../../apps/web/src/app/api/v1/mcp/route')).POST as Handler,
    subsPost: (await import('../../apps/web/src/app/api/v1/webhook-subscriptions/route'))
      .POST as Handler,
    deliveries: (
      await import('../../apps/web/src/app/api/v1/webhook-subscriptions/[id]/deliveries/route')
    ).GET as Handler,
    sales: (await import('../../apps/web/src/app/api/v1/seller/sales/route')).GET as Handler,
    orders: (await import('../../apps/web/src/app/api/v1/orders/route')).GET as Handler,
    agentBuy: (await import('../../apps/web/src/app/api/ops/agent-buy/route')).POST as Handler,
    opsStop: (await import('../../apps/web/src/app/api/ops/stop/route')).POST as Handler,
    opsStart: (await import('../../apps/web/src/app/api/ops/start/route')).POST as Handler,
    switches: (await import('../../apps/web/src/app/api/v1/ops/switches/route')).GET as Handler,
  };
  // 60 offers at $0.10 for the seller, each its own article (a buyer can hold an article once).
  const offers = await extraOffers(app, {
    publisher: PUBLISHER,
    from: 'tide-tables',
    count: OFFER_COUNT,
    price_minor: UNIT_MINOR,
  });
  return { app, routes, used: new Set(), offers, bought: [] };
}

/** One request with a bearer key. `route` is the OpenAPI path template, recorded for the coverage check. */
async function bearer(
  rig: Rig,
  handler: string,
  token: string | null,
  o: {
    method?: 'GET' | 'POST';
    route: string;
    url?: string;
    body?: unknown;
    params?: Record<string, string>;
    idem?: string | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const method = o.method ?? 'GET';
  rig.used.add(`${method} ${o.route}`);
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (method !== 'GET' && o.idem !== null) headers['idempotency-key'] = o.idem ?? idem('story');
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) {
    init.body = JSON.stringify(o.body);
    headers['content-type'] = 'application/json';
  }
  return rig.routes[handler]!(new Request(`${ORIGIN}${o.url ?? o.route}`, init), {
    params: Promise.resolve(o.params ?? {}),
  });
}

async function signIn(
  rig: Rig,
  body: Record<string, string>,
): Promise<{ session: Session; mfa: boolean | undefined; actor_kind: string }> {
  const res = await call(rig.routes['session']!, { url: '/api/session', method: 'POST', body });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { csrf_token: string; actor_kind: string; mfa?: boolean };
  return {
    session: {
      cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      csrf: json.csrf_token,
    },
    mfa: json.mfa,
    actor_kind: json.actor_kind,
  };
}

/** A session-signed POST (cookie, CSRF token, origin), the way the web pages call the old routes. */
const withSession = (
  rig: Rig,
  handler: string,
  session: Session,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> => call(rig.routes[handler]!, { url, method: 'POST', body, session, headers });

interface ToolResultBody {
  status: string;
  [k: string]: unknown;
}
/** One MCP tool call as an agent makes it: JSON-RPC 2.0 over POST /api/v1/mcp with the agent's key. */
async function mcpTool(
  rig: Rig,
  name: string,
  args: unknown = {},
): Promise<{ http: number; isError: boolean; out: ToolResultBody }> {
  const res = await bearer(rig, 'mcp', rig.agent!.token, {
    method: 'POST',
    route: '/api/v1/mcp',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const body = (await res.json()) as {
    result?: { isError?: boolean; structuredContent?: ToolResultBody };
  };
  return {
    http: res.status,
    isError: body.result?.isError === true,
    out: body.result?.structuredContent ?? { status: 'no_result' },
  };
}

const buyOffer = (rig: Rig, offer: string) =>
  mcpTool(rig, 'buy_unit', { publisher: PUBLISHER, offer, idempotency_key: idem('buy') });

const count = (rig: Rig, sql: string, p: unknown[] = []): Promise<number> => rows(rig.app, sql, p);

// ---------------------------------------------------------------------------------------------
// The steps. Each one asserts what the spec says and leaves what the next one needs on the rig.
// ---------------------------------------------------------------------------------------------
export const STEPS: { id: string; title: string; run: (rig: Rig) => Promise<void> }[] = [];
const step = (id: string, title: string, run: (rig: Rig) => Promise<void>): void => {
  STEPS.push({ id, title, run });
};

step(
  'P1-01',
  'a buyer signs in and issues an agent key with catalogue:read and agent:buy',
  async (rig) => {
    const s = await signIn(rig, { persona: 'buyer-a', passcode: PASSCODE });
    expect(s.actor_kind).toBe('buyer');
    rig.buyer = s.session;

    const issue = async (
      key_kind: string,
      scopes: string[],
    ): Promise<KeyPair & { scopes: string[] }> => {
      rig.used.add('POST /api/v1/api-keys');
      const res = await withSession(
        rig,
        'apiKeysPost',
        rig.buyer!,
        '/api/v1/api-keys',
        { key_kind, scopes },
        { 'idempotency-key': idem('key') },
      );
      expect(res.status).toBe(201);
      const k = (await res.json()) as {
        id: string;
        token: string;
        scopes: string[];
        key_kind: string;
      };
      expect(k.key_kind).toBe(key_kind);
      expect(k.token.length).toBeGreaterThan(20);
      return { id: k.id, token: k.token, scopes: k.scopes };
    };
    const agent = await issue('agent', ['catalogue:read', 'agent:buy']);
    expect([...agent.scopes].sort()).toEqual(['agent:buy', 'catalogue:read']);
    rig.agent = agent;
    // The buyer's own client key sets the cap and reads events; the agent's key can do neither.
    rig.buyerClient = await issue('api_client', ['mandates:write', 'events:read', 'orders:read']);

    // A list shows both keys and never a token or a hash.
    rig.used.add('GET /api/v1/api-keys');
    const list = await call(rig.routes['apiKeysGet']!, {
      url: '/api/v1/api-keys',
      session: rig.buyer,
    });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((i) => i['id'])).toEqual(
      expect.arrayContaining([agent.id, rig.buyerClient.id]),
    );
    expect(JSON.stringify(items)).not.toContain(agent.token);
    for (const i of items) expect(Object.keys(i)).not.toContain('token');
  },
);

step(
  'P1-02',
  'the buyer creates a mandate: a $5.00 money cap, a purchase count and an expiry in 24 hours',
  async (rig) => {
    const expires = new Date(rig.app.security.clock.now().getTime() + 24 * 3_600_000).toISOString();
    const body = {
      agent_key_id: rig.agent!.id,
      currency: 'USD',
      max_total_minor: CAP_MINOR,
      max_count: COUNT_CAP,
      expires_at: expires,
      terms_accepted: true,
    };
    // The agent cannot give itself a cap: its key holds no mandates:write.
    const self = await bearer(rig, 'mandates', rig.agent!.token, {
      method: 'POST',
      route: '/api/v1/mandates',
      body,
    });
    expect([401, 403]).toContain(self.status);
    expect(await count(rig, 'SELECT count(*) AS c FROM mandates')).toBe(0);

    const res = await bearer(rig, 'mandates', rig.buyerClient!.token, {
      method: 'POST',
      route: '/api/v1/mandates',
      body,
    });
    expect(res.status).toBe(201);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m).toMatchObject({
      agent_key_id: rig.agent!.id,
      currency: 'USD',
      max_total_minor: CAP_MINOR,
      max_count: COUNT_CAP,
      remaining_total_minor: CAP_MINOR,
      remaining_count: COUNT_CAP,
      spent_minor: 0,
      used_count: 0,
      revoked_at: null,
    });
    const left = Date.parse(m['expires_at'] as string) - rig.app.security.clock.now().getTime();
    expect(left).toBeGreaterThan(23 * 3_600_000);
    expect(left).toBeLessThanOrEqual(24 * 3_600_000);
    rig.mandateId = m['id'] as string;
  },
);

step(
  'P1-03',
  'an operator with the second factor turns agent_buy_enabled on; without it the switch stays off',
  async (rig) => {
    // Default off: the agent has a cap and a key, and is still refused.
    const before = await buyOffer(rig, rig.offers[0]!);
    expect(before.out.status).toBe('agent_buy_disabled');
    expect(before.isError).toBe(true);
    expect(await count(rig, 'SELECT count(*) AS c FROM orders')).toBe(0);

    // An operator who signed in without the authenticator code cannot turn it on.
    const weak = await signIn(rig, {
      persona: 'operator',
      passcode: PASSCODE,
      operator: 'vikram',
    });
    expect(weak.mfa).toBe(false);
    rig.operatorNoMfa = weak.session;
    const refused = await withSession(rig, 'agentBuy', weak.session, '/api/ops/agent-buy', {
      on: true,
      reason: 'w2 story, no second factor',
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe(
      'mfa_required',
    );
    expect((await buyOffer(rig, rig.offers[0]!)).out.status).toBe('agent_buy_disabled');

    // With the code it turns on.
    const strong = await signIn(rig, {
      persona: 'operator',
      passcode: PASSCODE,
      operator: 'vikram',
      code: totpCode(VIKRAM_B32, rig.app.security.clock.now().getTime()),
    });
    expect(strong.mfa).toBe(true);
    rig.operatorMfa = strong.session;
    const on = await withSession(rig, 'agentBuy', strong.session, '/api/ops/agent-buy', {
      on: true,
      reason: 'w2 story: dry-run agent purchases',
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ agent_buy_on: true });
    expect(await rig.app.engine.agentBuyEnabled()).toBe(true);
  },
);

step(
  'P1-04',
  'the seller issues a key with events:read and offers:write; both sides subscribe to their events',
  async (rig) => {
    const s = await signIn(rig, {
      persona: `publisher-${PUBLISHER}`,
      passcode: PUBLISHER_PASSCODE,
    });
    expect(s.actor_kind).toBe('publisher');
    rig.seller = s.session;
    rig.used.add('POST /api/v1/api-keys');
    const issued = await withSession(
      rig,
      'apiKeysPost',
      s.session,
      '/api/v1/api-keys',
      { key_kind: 'api_client', scopes: ['events:read', 'offers:write', 'sales:read'] },
      { 'idempotency-key': idem('key') },
    );
    expect(issued.status).toBe(201);
    const k = (await issued.json()) as { id: string; token: string };
    rig.sellerKey = { id: k.id, token: k.token };

    const subscribe = async (token: string, url: string, event_types: string[]) =>
      bearer(rig, 'subsPost', token, {
        method: 'POST',
        route: '/api/v1/webhook-subscriptions',
        body: { url, event_types },
      });

    // order.paid belongs to the buyer (a sale belongs to the seller): the seller key may not ask for it.
    const wrong = await subscribe(k.token, SELLER_HOOK, ['order.paid', 'sale.recorded']);
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error?: { code?: string } }).error?.code).toBe(
      'event_type_not_allowed',
    );

    const sell = await subscribe(k.token, SELLER_HOOK, ['sale.recorded']);
    expect(sell.status).toBe(201);
    const sellBody = (await sell.json()) as { id: string; signing_secret: string };
    expect(sellBody.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    rig.sellerSub = { id: sellBody.id, secret: sellBody.signing_secret };

    const buy = await subscribe(rig.buyerClient!.token, BUYER_HOOK, [
      'order.paid',
      'mandate.exhausted',
    ]);
    expect(buy.status).toBe(201);
    const buyBody = (await buy.json()) as { id: string; signing_secret: string };
    expect(buyBody.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(buyBody.signing_secret).not.toBe(sellBody.signing_secret);
    rig.buyerSub = { id: buyBody.id, secret: buyBody.signing_secret };
  },
);

step('P1-05', 'the agent lists the tools and reads its budget over MCP', async (rig) => {
  const res = await bearer(rig, 'mcp', rig.agent!.token, {
    method: 'POST',
    route: '/api/v1/mcp',
    body: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
  });
  expect(res.status).toBe(200);
  const list = (await res.json()) as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((t) => t.name).sort()).toEqual([
    'buy_unit',
    'check_budget',
    'get_offer',
    'open_unit',
    'propose_pack',
    'search_catalogue',
  ]);

  const budget = await mcpTool(rig, 'check_budget');
  expect(budget.isError).toBe(false);
  expect(budget.out).toMatchObject({
    status: 'active',
    mandate_id: rig.mandateId,
    currency: 'USD',
    remaining_total_minor: CAP_MINOR,
    remaining_count: COUNT_CAP,
  });

  const found = await mcpTool(rig, 'search_catalogue', { publisher: PUBLISHER, limit: 5 });
  expect(found.out.status).toBe('ok');
  expect((found.out['items'] as unknown[]).length).toBeGreaterThan(0);
});

step('P1-06', 'the agent buys a $0.10 unit 50 times: 50 orders paid', async (rig) => {
  for (let i = 0; i < BOUGHT; i += 1) {
    const r = await buyOffer(rig, rig.offers[i]!);
    expect(r.out.status, `purchase ${String(i + 1)}`).toBe('bought');
    expect(r.isError).toBe(false);
    expect(r.out['environment']).toBe('dryrun');
    rig.bought.push(r.out['order_ref'] as string);
  }
  expect(new Set(rig.bought).size).toBe(BOUGHT);
  expect(await count(rig, "SELECT count(*) AS c FROM orders WHERE status = 'paid'")).toBe(BOUGHT);
  expect(await count(rig, 'SELECT count(*) AS c FROM orders')).toBe(BOUGHT);
  rig.ordersAfterBuying = BOUGHT;

  // The buyer sees the same 50 over the API with its own key.
  const list = await bearer(rig, 'orders', rig.buyerClient!.token, {
    route: '/api/v1/orders',
    url: '/api/v1/orders?limit=50',
  });
  expect(list.status).toBe(200);
  const page = (await list.json()) as { items: { status: string }[] };
  expect(page.items).toHaveLength(BOUGHT);
  for (const o of page.items) expect(o.status).toBe('paid');

  // Money spent is exactly the cap; the count cap has 10 left, so the money cap is the one that bites.
  const left = await mcpTool(rig, 'check_budget');
  expect(left.out).toMatchObject({
    status: 'active',
    remaining_total_minor: 0,
    remaining_count: COUNT_CAP - BOUGHT,
  });
  const spent = await count(
    rig,
    "SELECT coalesce(sum(r.amount_minor), 0) AS c FROM mandate_reservations r WHERE r.mandate_id = $1 AND r.state = 'committed'",
    [rig.mandateId],
  );
  expect(spent).toBe(CAP_MINOR);
});

step(
  'P1-07',
  'the 51st buy_unit is refused with cap_exhausted and no order row; one mandate.exhausted event exists',
  async (rig) => {
    const r = await buyOffer(rig, rig.offers[BOUGHT]!);
    expect(r.out.status).toBe('cap_exhausted');
    expect(r.isError).toBe(true);
    expect(r.http).toBe(200);
    // No order row for the refused unit, and the count of orders did not move.
    expect(await count(rig, 'SELECT count(*) AS c FROM orders')).toBe(BOUGHT);
    // No order unit and no reservation exists beyond the 50 that were bought.
    expect(await count(rig, 'SELECT count(*) AS c FROM order_units')).toBe(BOUGHT);
    expect(
      await count(rig, 'SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1', [
        rig.mandateId,
      ]),
    ).toBe(BOUGHT);
    // Asking again changes nothing: still refused, still one event.
    expect((await buyOffer(rig, rig.offers[BOUGHT + 1]!)).out.status).toBe('cap_exhausted');
    expect(await count(rig, 'SELECT count(*) AS c FROM orders')).toBe(BOUGHT);

    const events = await rig.app.db.query<{ reason: string }>(
      "SELECT payload->>'reason' AS reason FROM event_outbox WHERE type = 'mandate.exhausted' AND payload->>'agent_key_id' = $1",
      [rig.agent!.id],
    );
    expect(events.rows).toEqual([{ reason: 'money' }]);
  },
);

step(
  'P1-08',
  'after one delivery pass the sinks hold 50 order.paid and 50 sale.recorded, every signature verifies',
  async (rig) => {
    const sink = rig.app.webhook_sink;
    // Nothing is sent until a pass runs.
    expect(sink.records).toHaveLength(0);
    const counts = await rig.app.deliverWebhooks({ max_items: 1000 });
    // 50 order.paid + 50 sale.recorded + 1 mandate.exhausted, each to the one subscription that asked.
    expect(counts).toMatchObject({
      attempted: 2 * BOUGHT + 1,
      delivered: 2 * BOUGHT + 1,
      failed: 0,
      dead: 0,
    });
    expect(sink.records).toHaveLength(2 * BOUGHT + 1);

    const secretOf = new Map([
      [BUYER_HOOK, rig.buyerSub!.secret],
      [SELLER_HOOK, rig.sellerSub!.secret],
    ]);
    const typesAt = (url: string): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const r of sink.records.filter((x) => x.url === url)) {
        const type = (JSON.parse(r.body) as { type: string }).type;
        t[type] = (t[type] ?? 0) + 1;
      }
      return t;
    };
    expect(typesAt(BUYER_HOOK)).toEqual({ 'order.paid': BOUGHT, 'mandate.exhausted': 1 });
    expect(typesAt(SELLER_HOOK)).toEqual({ 'sale.recorded': BOUGHT });

    const now = rig.app.security.clock.now();
    const ids = new Set<string>();
    for (const r of sink.records) {
      const secret = secretOf.get(r.url)!;
      const header = r.headers['UnitMarket-Signature']!;
      expect(verifySignature(secret, header, r.body, now), r.headers['UnitMarket-Event-Id']).toBe(
        true,
      );
      // The other party's secret does not verify, and neither does a changed body.
      const other = [...secretOf.values()].find((s) => s !== secret)!;
      expect(verifySignature(other, header, r.body, now)).toBe(false);
      expect(verifySignature(secret, header, `${r.body} `, now)).toBe(false);
      ids.add(r.headers['UnitMarket-Event-Id']!);
    }
    expect(ids.size).toBe(2 * BOUGHT + 1);

    // A second pass finds nothing new to send.
    const again = await rig.app.deliverWebhooks({ max_items: 1000 });
    expect(again).toMatchObject({ attempted: 0, delivered: 0 });
    expect(sink.records).toHaveLength(2 * BOUGHT + 1);

    // The seller sees the same 50 sales over the API, and 50 delivered rows on its subscription.
    const sales = await bearer(rig, 'sales', rig.sellerKey!.token, {
      route: '/api/v1/seller/sales',
    });
    expect(sales.status).toBe(200);
    expect(((await sales.json()) as { items: unknown[] }).items).toHaveLength(BOUGHT);
    const dl = await bearer(rig, 'deliveries', rig.sellerKey!.token, {
      route: '/api/v1/webhook-subscriptions/{id}/deliveries',
      url: `/api/v1/webhook-subscriptions/${rig.sellerSub!.id}/deliveries`,
      params: { id: rig.sellerSub!.id },
    });
    expect(dl.status).toBe(200);
    const items = ((await dl.json()) as { items: { status: string }[] }).items;
    expect(items).toHaveLength(BOUGHT);
    for (const d of items) expect(d.status).toBe('delivered');
  },
);

step(
  'P1-09',
  'the operator stops agent buying without the second factor and the next buy_unit is refused',
  async (rig) => {
    const stop = await withSession(rig, 'opsStop', rig.operatorNoMfa!, '/api/ops/stop', {
      reason: 'w2 story: stop all agent buying',
    });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ outbound_on: false });
    expect(await rig.app.engine.agentBuyEnabled()).toBe(false);

    const r = await buyOffer(rig, rig.offers[BOUGHT + 2]!);
    expect(r.out.status).toBe('agent_buy_disabled');
    expect(r.isError).toBe(true);
    expect(await count(rig, 'SELECT count(*) AS c FROM orders')).toBe(BOUGHT);
    // Reading the budget still works: stopping buying does not hide the cap.
    expect((await mcpTool(rig, 'check_budget')).out.status).toBe('active');
  },
);

step(
  'P1-10',
  'neither the agent key nor the seller key can start or stop anything: the ops routes refuse a key',
  async (rig) => {
    const statusOf = async (handler: string, token: string, route: string, body: unknown) => {
      const res = await bearer(rig, handler, token, { method: 'POST', route, body });
      return res.status;
    };
    for (const [who, token] of [
      ['agent', rig.agent!.token],
      ['seller', rig.sellerKey!.token],
      ['buyer', rig.buyerClient!.token],
    ] as const) {
      const start = await statusOf('opsStart', token, '/api/ops/start', {
        reason: `w2 story, ${who} key`,
        confirm_scope: 'none',
      });
      const stop = await statusOf('opsStop', token, '/api/ops/stop', {
        reason: `w2 story, ${who} key`,
      });
      expect([401, 403], `${who} start`).toContain(start);
      expect([401, 403], `${who} stop`).toContain(stop);
    }
    // Nothing changed: agent buying is still off and no order was added.
    expect(await rig.app.engine.agentBuyEnabled()).toBe(false);
    expect(await count(rig, 'SELECT count(*) AS c FROM orders')).toBe(BOUGHT);
  },
);

step('P1-11', 'the OpenAPI document lists every /api/v1 route the story used', async (rig) => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const doc = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../docs/api/openapi-v1.json', import.meta.url)), 'utf8'),
  ) as { paths: Record<string, Record<string, unknown>> };
  const v1 = [...rig.used].filter((r) => r.split(' ')[1]!.startsWith('/api/v1/'));
  expect(v1.length).toBeGreaterThanOrEqual(8);
  for (const r of v1) {
    const [method, path] = r.split(' ') as [string, string];
    expect(doc.paths[path], `${r} is not in the OpenAPI document`).toBeDefined();
    expect(Object.keys(doc.paths[path]!), r).toContain(method.toLowerCase());
  }
});
