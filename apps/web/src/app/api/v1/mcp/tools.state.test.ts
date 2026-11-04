// API-B (G5 to G8, G11, G12): each tool once through tools/call with its result shape; propose_pack buys
// nothing; open_unit refuses a unit the buyer does not own; the discovery file needs no key; an offer whose
// rights say ai_scope not_allowed is absent from search and refused by get_offer and buy_unit.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import {
  buyArgs,
  newAgent,
  rows,
  setAgentBuy,
  setAiScope,
  tool,
  type Handler,
} from './agent-test-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

let app: App;
let buyerA: Actor;
let buyerB: Actor;
let a: { key_id: string; token: string };
let b: { key_id: string; token: string };

beforeAll(async () => {
  app = await bootPackApp();
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  a = await newAgent(app, buyerA, { mandate: { max_count: 5, max_total_minor: 100_000 } });
  b = await newAgent(app, buyerB, { mandate: { max_count: 5, max_total_minor: 100_000 } });
  await setAgentBuy(app, true);
});

interface Item {
  publisher: string;
  offer: string;
  title: string;
  currency: string;
  options: { option: string; price_minor: number }[];
  ai_scope: string;
}

describe('G5 search_catalogue', () => {
  it('lists offers with what an agent needs to decide: publisher, code, title, prices, ai_scope', async () => {
    const r = await tool(a.token, 'search_catalogue', {});
    expect(r.out.status).toBe('ok');
    const items = r.out['items'] as Item[];
    expect(items.length).toBeGreaterThan(3);
    expect(items[0]).toEqual(
      expect.objectContaining({
        publisher: expect.any(String),
        offer: expect.any(String),
        title: expect.any(String),
        currency: expect.stringMatching(/^[A-Z]{3}$/),
        ai_scope: expect.stringMatching(/^(agent_allowed|review)$/),
      }),
    );
    expect(items[0]!.options[0]).toEqual({
      option: expect.any(String),
      price_minor: expect.any(Number),
    });
    expect(r.out).toHaveProperty('next_cursor');
  });

  it('filters by text, by highest price and by publisher, and pages with a cursor', async () => {
    const tide = (await tool(a.token, 'search_catalogue', { q: 'tide' })).out['items'] as Item[];
    expect(tide.length).toBeGreaterThan(0);
    expect(tide.every((i) => /tide/i.test(`${i.title} ${i.offer}`))).toBe(true);
    const cheap = (await tool(a.token, 'search_catalogue', { max_price_minor: 60 })).out[
      'items'
    ] as Item[];
    expect(cheap.every((i) => Math.min(...i.options.map((o) => o.price_minor)) <= 60)).toBe(true);
    const harbour = (await tool(a.token, 'search_catalogue', { publisher: 'harbour-ledger' })).out[
      'items'
    ] as Item[];
    expect(harbour.length).toBeGreaterThan(0);
    expect(harbour.every((i) => i.publisher === 'harbour-ledger')).toBe(true);
    const p1 = await tool(a.token, 'search_catalogue', { limit: 2 });
    const first = p1.out['items'] as Item[];
    expect(first).toHaveLength(2);
    const p2 = await tool(a.token, 'search_catalogue', { limit: 2, cursor: p1.out['next_cursor'] });
    const second = p2.out['items'] as Item[];
    expect(second.map((i) => i.offer)).not.toEqual(first.map((i) => i.offer));
  });

  it('G12 leaves out an offer whose rights say ai_scope not_allowed, and shows review as review', async () => {
    const before = (
      (await tool(a.token, 'search_catalogue', { publisher: 'harbour-ledger' })).out[
        'items'
      ] as Item[]
    ).map((i) => i.offer);
    expect(before).toContain('ferry-timetables');
    await setAiScope(app, 'harbour-ledger', 'ferry-timetables', 'not_allowed');
    await setAiScope(app, 'harbour-ledger', 'tide-tables', 'review');
    const items = (await tool(a.token, 'search_catalogue', { publisher: 'harbour-ledger' })).out[
      'items'
    ] as Item[];
    expect(items.map((i) => i.offer)).not.toContain('ferry-timetables');
    expect(items.find((i) => i.offer === 'tide-tables')!.ai_scope).toBe('review');
    expect(items.every((i) => i.ai_scope !== 'not_allowed')).toBe(true);
  });
});

describe('G6 get_offer', () => {
  it('returns one offer with its rights and the options', async () => {
    const r = await tool(a.token, 'get_offer', {
      publisher: 'harbour-ledger',
      offer: 'knot-notebook',
    });
    expect(r.out.status).toBe('ok');
    expect(r.out['offer']).toMatchObject({
      publisher: 'harbour-ledger',
      offer: 'knot-notebook',
      ai_scope: expect.any(String),
      options: expect.any(Array),
    });
  });
  it('an offer that does not exist is not_found', async () => {
    expect(
      (await tool(a.token, 'get_offer', { publisher: 'harbour-ledger', offer: 'nope' })).out.status,
    ).toBe('not_found');
  });
  it('G12 an offer with ai_scope not_allowed is refused with ai_not_allowed, and says nothing else about it', async () => {
    const r = await tool(a.token, 'get_offer', {
      publisher: 'harbour-ledger',
      offer: 'ferry-timetables',
    });
    expect(r.out.status).toBe('ai_not_allowed');
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.out)).not.toMatch(/price_minor|abstract/);
  });
});

describe('G7 propose_pack', () => {
  it('discovers and quotes, and writes no order, approval or entitlement', async () => {
    const before = {
      orders: await rows(app, 'SELECT count(*) AS c FROM orders'),
      approvals: await rows(app, 'SELECT count(*) AS c FROM approvals'),
      entitlements: await rows(app, 'SELECT count(*) AS c FROM entitlements'),
      reservations: await rows(app, 'SELECT count(*) AS c FROM mandate_reservations'),
    };
    const r = await tool(a.token, 'propose_pack', { need: 'tide tables, read online' });
    expect(r.out.status).toBe('ok');
    expect(r.out['proposal_id']).toMatch(/^prp_/);
    const items = r.out['items'] as {
      offer_id: string;
      price_minor: number;
      currency: string;
      ai_scope: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.ai_scope !== 'not_allowed')).toBe(true);
    expect({
      orders: await rows(app, 'SELECT count(*) AS c FROM orders'),
      approvals: await rows(app, 'SELECT count(*) AS c FROM approvals'),
      entitlements: await rows(app, 'SELECT count(*) AS c FROM entitlements'),
      reservations: await rows(app, 'SELECT count(*) AS c FROM mandate_reservations'),
    }).toEqual(before);
  });
  it('a need that matches nothing says no_match', async () => {
    const r = await tool(a.token, 'propose_pack', { need: 'zzzz qqqq xxxx' });
    expect(['no_match', 'ok']).toContain(r.out.status);
  });
});

describe('G8 open_unit', () => {
  it('gives a library link for a unit the buyer owns', async () => {
    const bought = await tool(a.token, 'buy_unit', buyArgs('harbour-ledger', 'knot-notebook'));
    expect(bought.out.status).toBe('bought');
    const lib = await app.engine.library({ actor: buyerA });
    const unit = lib.find((e) => e.title.length > 0)!;
    const r = await tool(a.token, 'open_unit', { entitlement_id: unit.entitlement_id });
    expect(r.out.status).toBe('ok');
    expect(String(r.out['url'])).toMatch(/^https?:\/\/|^\//);
  });
  it('refuses a unit the buyer does not own, with the same answer as one that does not exist', async () => {
    const lib = await app.engine.library({ actor: buyerA });
    const mine = lib[0]!.entitlement_id;
    const theirs = await tool(b.token, 'open_unit', { entitlement_id: mine });
    const none = await tool(b.token, 'open_unit', { entitlement_id: 'ent_doesnotexist' });
    expect(theirs.out.status).toBe('not_found');
    expect(none.out).toEqual(theirs.out);
  });
  it('needs library:read', async () => {
    const noLib = await newAgent(app, buyerA, {
      scopes: ['catalogue:read', 'agent:buy'],
      mandate: null,
    });
    const lib = await app.engine.library({ actor: buyerA });
    expect(
      (await tool(noLib.token, 'open_unit', { entitlement_id: lib[0]!.entitlement_id })).out.status,
    ).toBe('forbidden');
  });
});

describe('G12 buy_unit refuses an offer that is not allowed for AI', () => {
  it('ai_not_allowed, no approval, no order, nothing reserved', async () => {
    const before = await rows(app, 'SELECT count(*) AS c FROM orders');
    const held = await rows(
      app,
      "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'",
    );
    const r = await tool(a.token, 'buy_unit', buyArgs('harbour-ledger', 'ferry-timetables'));
    expect(r.out.status).toBe('ai_not_allowed');
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(before);
    expect(
      await rows(app, "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'"),
    ).toBe(held);
  });
});

describe('G11 GET /.well-known/mcp', () => {
  it('needs no key and names the endpoint, the six tools and the bearer scheme', async () => {
    const route = (await import('../../../.well-known/mcp/route')) as { GET: Handler };
    const res = await route.GET(new Request('http://localhost:3000/.well-known/mcp'));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      endpoint: string;
      transport: string;
      tools: string[];
      auth: { scheme: string; scopes: string[] };
      required_headers: string[];
    };
    expect(doc.endpoint).toBe('http://localhost:3000/api/v1/mcp');
    expect(doc.transport).toBe('json-rpc-over-http');
    expect(doc.tools).toEqual([
      'search_catalogue',
      'get_offer',
      'propose_pack',
      'open_unit',
      'check_budget',
      'buy_unit',
    ]);
    expect(doc.auth.scheme).toBe('bearer');
    expect(doc.required_headers).toContain('Idempotency-Key');
  });
  it('leaks no key, no secret and no host but its own', async () => {
    const route = (await import('../../../.well-known/mcp/route')) as { GET: Handler };
    const text = await (
      await route.GET(new Request('http://localhost:3000/.well-known/mcp'))
    ).text();
    expect(text).not.toMatch(/umk_|secret|paypal/i);
  });
});
