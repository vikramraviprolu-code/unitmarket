// API-B (G10, L item; G4, G9): attacks on buy_unit through the MCP route, in dry-run and in sandbox mode.
// Whatever an agent sends or however it races, it never buys past its cap, never without a mandate, never
// for another buyer, never with the switch off. 20 calls on a 5-purchase cap buy exactly 5. The sandbox part
// proves buy_unit calls nothing and the handoff page shows an order to its buyer only.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { HARBOUR_TIDE, bootPackApp, buyer, proposalFor } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { createApiV1, installApp } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { resolveHandoff } from '../../../../api-v1/agent-handoff';
import {
  bootSandboxApp,
  buyArgs,
  extraOffers,
  idem,
  newAgent,
  newClientKey,
  rows,
  setAgentBuy,
  tool,
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
let units: string[];
const H = 'harbour-ledger';
const buy = (token: string, code: string, key = idem('buy'), more: object = {}) =>
  tool(token, 'buy_unit', buyArgs(H, code, key, more));
const orders = () => rows(app, 'SELECT count(*) AS c FROM orders');
const reserved = () =>
  rows(app, "SELECT count(*) AS c FROM mandate_reservations WHERE state IN ('held','committed')");
const statuses = (rs: { out: { status: string } }[]) => rs.map((r) => r.out.status);
const count = (rs: { out: { status: string } }[], s: string) =>
  statuses(rs).filter((x) => x === s).length;

beforeAll(async () => {
  app = await bootPackApp();
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  units = await extraOffers(app, { publisher: H, from: 'tide-tables', count: 40, price_minor: 30 });
  await setAgentBuy(app, true);
}, 120_000);

describe('the cap holds under 20 concurrent buy_unit calls', () => {
  it('a 5-purchase cap buys exactly 5, the rest are cap_exhausted, and only 5 orders exist', async () => {
    const a = await newAgent(app, buyerA, {
      mandate: { max_count: 5, max_total_minor: 1_000_000 },
    });
    const before = await orders();
    const rs = await Promise.all(units.slice(0, 20).map((u) => buy(a.token, u)));
    expect(count(rs, 'bought')).toBe(5);
    expect(count(rs, 'cap_exhausted')).toBe(15);
    expect((await orders()) - before).toBe(5);
    const left = await tool(a.token, 'check_budget');
    expect(left.out).toMatchObject({ status: 'active', remaining_count: 0 });
  });

  it('20 buys of 30 minor units on a 100 money cap buy exactly 3 and never pass the cap by one', async () => {
    const b = await newAgent(app, buyerB, { mandate: { max_total_minor: 100 } });
    const rs = await Promise.all(units.slice(0, 20).map((u) => buy(b.token, u)));
    expect(count(rs, 'bought')).toBe(3);
    const left = await tool(b.token, 'check_budget');
    expect(left.out['remaining_total_minor']).toBe(10);
  });
});

describe('no cap, no purchase', () => {
  it('an agent with no mandate is told to ask the buyer for one and nothing is booked', async () => {
    const a = await newAgent(app, buyerA, { mandate: null });
    const before = { o: await orders(), r: await reserved() };
    const r = await buy(a.token, units[30]!);
    expect(r.out.status).toBe('mandate_required');
    expect(String(r.out['ask_buyer'])).toMatch(/money/i);
    expect(String(r.out['ask_buyer'])).toMatch(/purchases/i);
    expect({ o: await orders(), r: await reserved() }).toEqual(before);
  });

  it('a revoked mandate and an expired mandate are refused', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 3 } });
    await createApiV1(app).mandates.revoke(
      (buyerA as Extract<Actor, { kind: 'buyer' }>).buyer_id,
      a.mandate!.id,
    );
    expect((await buy(a.token, units[31]!)).out.status).toBe('mandate_required');
    const e = await newAgent(app, buyerA, { mandate: { max_count: 3, expires_in_days: 1 } });
    // the app reads the real clock, so a mandate that ends one millisecond from now is over after a short wait
    await app.db.query('UPDATE mandates SET expires_at = $2 WHERE id = $1', [
      e.mandate!.id,
      new Date(app.security.clock.now().getTime() + 1).toISOString(),
    ]);
    await new Promise((r) => setTimeout(r, 25));
    const before = await orders();
    const r = await buy(e.token, units[32]!);
    expect(r.out.status).toBe('mandate_required');
    expect(r.out['reason']).toBe('expired');
    expect(await orders()).toBe(before);
  });
});

describe('who may buy', () => {
  it('the agent of buyer A cannot use the mandate of buyer B: it has none, and is asked for one', async () => {
    const withMandate = await newAgent(app, buyerB, { mandate: { max_count: 9 } });
    const bare = await newAgent(app, buyerA, { mandate: null });
    expect((await buy(bare.token, units[33]!)).out.status).toBe('mandate_required');
    expect(
      (
        await tool(
          bare.token,
          'buy_unit',
          buyArgs(H, units[33]!, idem('x'), { mandate_id: withMandate.mandate!.id }),
        )
      ).out.status,
    ).toBe('invalid_arguments');
    expect((await tool(bare.token, 'check_budget')).out.status).toBe('mandate_required');
  });

  it('a mandate bound to agent key A cannot be used by agent key B of the same buyer', async () => {
    const keyA = await newAgent(app, buyerA, { mandate: { max_count: 9 } });
    const keyB = await newAgent(app, buyerA, { mandate: null });
    expect((await buy(keyB.token, units[34]!)).out.status).toBe('mandate_required');
    expect((await buy(keyA.token, units[34]!)).out.status).toBe('bought');
  });

  it('an agent key without agent:buy is refused, for buy_unit and check_budget, and nothing is booked', async () => {
    const readOnly = await newAgent(app, buyerA, {
      scopes: ['catalogue:read', 'library:read'],
      mandate: { max_count: 3 },
    });
    const before = await orders();
    expect((await buy(readOnly.token, units[35]!)).out.status).toBe('forbidden');
    expect((await tool(readOnly.token, 'check_budget')).out.status).toBe('forbidden');
    expect(await orders()).toBe(before);
  });

  it('a buyer API client key cannot buy: it cannot even connect', async () => {
    const c = await newClientKey(app, buyerA, ['catalogue:read', 'mandates:write']);
    expect((await buy(c.token, units[35]!)).status).toBe(403);
  });
});

describe('the operator switch agent_buy_enabled', () => {
  it('off refuses every purchase with a plain reason, books nothing and writes no order row', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 5 } });
    await setAgentBuy(app, false);
    try {
      const before = {
        o: await orders(),
        r: await reserved(),
        a: await rows(app, 'SELECT count(*) AS c FROM approvals'),
      };
      const r = await buy(a.token, units[36]!);
      expect(r.out.status).toBe('agent_buy_disabled');
      expect(r.isError).toBe(true);
      expect({
        o: await orders(),
        r: await reserved(),
        a: await rows(app, 'SELECT count(*) AS c FROM approvals'),
      }).toEqual(before);
      // reading still works with the switch off
      expect((await tool(a.token, 'check_budget')).out.status).toBe('active');
    } finally {
      await setAgentBuy(app, true);
    }
    expect((await buy(a.token, units[36]!)).out.status).toBe('bought');
  });

  it('starts off on a fresh database', async () => {
    const fresh = await bootPackApp();
    const r = await fresh.db.query<{ on: boolean }>(
      'SELECT "on" FROM safety_switches WHERE name = \'agent_buy_enabled\'',
    );
    expect(r.rows[0]!.on).toBe(false);
    expect(await fresh.engine.agentBuyEnabled()).toBe(false);
    await fresh.close();
    // booting installs the new app for the routes; put the shared one back
    installApp(app);
    expect(await app.engine.agentBuyEnabled()).toBe(true);
  });
});

describe('replays', () => {
  it('the same idempotency_key buys once, sequentially and concurrently, and returns the first answer', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 9 } });
    const key = idem('same');
    const first = await buy(a.token, units[20]!, key);
    const again = await buy(a.token, units[20]!, key);
    expect(first.out.status).toBe('bought');
    expect(again.out).toEqual(first.out);
    const ref = String(first.out['order_ref']);
    expect(await rows(app, 'SELECT count(*) AS c FROM orders WHERE order_ref = $1', [ref])).toBe(1);
    const k2 = idem('race');
    const rs = await Promise.all(Array.from({ length: 6 }, () => buy(a.token, units[21]!, k2)));
    expect(
      await rows(
        app,
        'SELECT count(*) AS c FROM orders o JOIN order_units u ON u.order_id = o.id JOIN entitlements e ON e.unit_id = u.id WHERE e.article_id = $1',
        [`art_${H}_${units[21]!}`],
      ),
    ).toBe(1);
    expect(statuses(rs).filter((s) => s === 'bought').length).toBeGreaterThanOrEqual(1);
    expect(statuses(rs).every((s) => s === 'bought' || s === 'in_progress')).toBe(true);
    expect((await tool(a.token, 'check_budget')).out['remaining_count']).toBe(7);
  });

  it('the same key with a different offer is refused, not a second purchase', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 9 } });
    const key = idem('mixed');
    expect((await buy(a.token, units[22]!, key)).out.status).toBe('bought');
    expect((await buy(a.token, units[23]!, key)).out.status).toBe('idempotency_key_reused');
  });

  it('a key used by another agent key is a different purchase', async () => {
    const a1 = await newAgent(app, buyerA, { mandate: { max_count: 2 } });
    const a2 = await newAgent(app, buyerB, { mandate: { max_count: 2 } });
    const key = idem('shared');
    expect((await buy(a1.token, units[24]!, key)).out.status).toBe('bought');
    expect((await buy(a2.token, units[24]!, key)).out.status).toBe('bought');
  });
});

describe('currency and size', () => {
  it('a USD mandate on a EUR or GBP offer is refused, never converted, and books nothing', async () => {
    const a = await newAgent(app, buyerA, {
      mandate: { max_count: 5, max_total_minor: 1_000_000 },
    });
    const other = await app.db.query<{ id: string; currency: string; slug: string }>(
      `SELECT o.id, o.currency, p.slug FROM offers o JOIN publishers p ON p.id = o.publisher_id WHERE o.currency <> 'USD' AND o.status = 'authorised' LIMIT 2`,
    );
    expect(other.rows.length).toBeGreaterThan(0);
    for (const o of other.rows) {
      const before = { o: await orders(), r: await reserved() };
      const r = await tool(
        a.token,
        'buy_unit',
        buyArgs(o.slug, o.id.replace(`ofr_${o.slug}_`, '')),
      );
      expect(r.out.status, o.currency).toBe('currency_mismatch');
      expect({ o: await orders(), r: await reserved() }).toEqual(before);
    }
  });

  it('a pack of two units is checked against the per-purchase maximum for the whole amount', async () => {
    const p = await proposalFor(app, buyerA, [
      HARBOUR_TIDE,
      ['harbour-ledger', 'ferry-timetables'],
    ]);
    const items = await app.db.query<{ price_minor: number }>(
      `SELECT q.price_minor FROM quotes q WHERE q.buyer_id = $1 ORDER BY q.created_at DESC LIMIT 2`,
      [(buyerA as Extract<Actor, { kind: 'buyer' }>).buyer_id],
    );
    const prices = items.rows.map((x) => x.price_minor);
    const total = prices.reduce((n, x) => n + x, 0);
    const biggest = Math.max(...prices);
    // each unit fits the per-purchase maximum on its own; the two together do not
    const a = await newAgent(app, buyerA, {
      mandate: { max_count: 5, max_total_minor: 100_000, max_per_purchase_minor: biggest },
    });
    expect(total).toBeGreaterThan(biggest);
    const before = await orders();
    const r = await tool(a.token, 'buy_unit', {
      proposal_id: p.proposal_id,
      offer_ids: p.offer_ids,
      idempotency_key: idem('pack'),
    });
    expect(r.out.status).toBe('over_per_purchase');
    expect(await orders()).toBe(before);
  });

  it('refuses arguments that are not what the tool takes: extra fields, a short key, too many items', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 5 } });
    expect(
      (await tool(a.token, 'buy_unit', { publisher: H, offer: units[0], idempotency_key: 'short' }))
        .out.status,
    ).toBe('invalid_arguments');
    expect((await tool(a.token, 'buy_unit', { publisher: H, offer: units[0] })).out.status).toBe(
      'invalid_arguments',
    );
    expect(
      (await tool(a.token, 'buy_unit', buyArgs(H, units[0]!, idem('x'), { price_minor: 1 }))).out
        .status,
    ).toBe('invalid_arguments');
    expect(
      (
        await tool(a.token, 'buy_unit', {
          proposal_id: 'prp_1',
          offer_ids: ['a', 'b', 'c', 'd', 'e', 'f'],
          idempotency_key: idem('x'),
        })
      ).out.status,
    ).toBe('invalid_arguments');
  });
});

describe('revoke while buying', () => {
  it('a revoke in the middle of ten purchases stops the rest; nothing is booked after it', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 30 } });
    const mid = createApiV1(app).mandates.revoke(
      (buyerA as Extract<Actor, { kind: 'buyer' }>).buyer_id,
      a.mandate!.id,
    );
    const rs = await Promise.all(
      [
        ...units.slice(0, 5).map((u) => buy(a.token, u)),
        mid,
        ...units.slice(5, 10).map((u) => buy(a.token, u)),
      ].map((p) => Promise.resolve(p)),
    );
    const bought = rs.filter((r) => 'out' in r && r.out.status === 'bought').length;
    const after = await tool(a.token, 'check_budget');
    expect(after.out.status).toBe('mandate_required');
    expect(
      await rows(app, 'SELECT used_count AS c FROM mandates WHERE id = $1', [a.mandate!.id]),
    ).toBe(bought);
    expect((await buy(a.token, units[11]!)).out.status).toBe('mandate_required');
  });
});

describe('the cap comes back when an order ends without payment, and not before', () => {
  it('an order that ended unpaid releases its reservation at the next budget read; a paid one keeps it', async () => {
    const a = await newAgent(app, buyerA, { mandate: { max_count: 2 } });
    const one = await buy(a.token, units[25]!);
    expect(one.out.status).toBe('bought');
    const ref = String(one.out['order_ref']);
    // a bought order is committed: ending it later cannot give the room back
    await app.db.query("UPDATE orders SET status = 'abandoned' WHERE order_ref = $1", [ref]);
    expect((await tool(a.token, 'check_budget')).out['remaining_count']).toBe(1);
  });
});

describe('the sandbox environment: buy_unit hands the buyer a UnitMarket page and calls nothing', () => {
  let sbx: App;
  let dir: string;
  let owner: Actor;
  let other: Actor;
  let agent: { key_id: string; token: string };
  let ref: string;
  beforeAll(async () => {
    ({ app: sbx, dir } = await bootSandboxApp());
    owner = await buyer(sbx, 'a');
    other = await buyer(sbx, 'b');
    await setAgentBuy(sbx, true);
    agent = await newAgent(sbx, owner, { mandate: { max_count: 3, max_total_minor: 10_000 } });
  }, 120_000);
  afterAll(async () => {
    await sbx?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns buyer_approval_required with a /buy/agent/{order_ref} link of ours, no PayPal link', async () => {
    const r = await tool(agent.token, 'buy_unit', buyArgs(H, 'tide-tables'));
    expect(r.out.status).toBe('buyer_approval_required');
    ref = String(r.out['order_ref']);
    expect(String(r.out['checkout_url'])).toBe(`http://localhost:3000/buy/agent/${ref}`);
    expect(JSON.stringify(r.out)).not.toMatch(/paypal\.com|approve_url/i);
    expect(r.out['environment']).toBe('sandbox');
    expect(
      await rows(
        sbx,
        'SELECT count(*) AS c FROM provider_orders WHERE provider_order_id IS NOT NULL',
      ),
    ).toBe(0);
    expect(
      await rows(sbx, "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'"),
    ).toBe(1);
  });

  it('shows the order to its own buyer with a pay button, and to nobody else', async () => {
    const mine = await resolveHandoff(sbx, owner, ref);
    expect(mine).toMatchObject({ kind: 'show', can_pay: true });
    expect(await resolveHandoff(sbx, other, ref)).toEqual({ kind: 'not_found' });
    expect(await resolveHandoff(sbx, other, 'ord_doesnotexist')).toEqual({ kind: 'not_found' });
    expect(await resolveHandoff(sbx, null, ref)).toEqual({
      kind: 'signin',
      next: `/buy/agent/${ref}`,
    });
    const publisher: Actor = {
      kind: 'publisher',
      publisher_id: (
        await sbx.db.query<{ id: string }>(
          "SELECT id FROM publishers WHERE slug = 'harbour-ledger'",
        )
      ).rows[0]!.id,
    };
    expect(await resolveHandoff(sbx, publisher, ref)).toEqual({
      kind: 'signin',
      next: `/buy/agent/${ref}`,
    });
    // opening it, as anyone, created no PayPal order
    expect(
      await rows(
        sbx,
        'SELECT count(*) AS c FROM provider_orders WHERE provider_order_id IS NOT NULL',
      ),
    ).toBe(0);
  });

  it('a paid, abandoned or failed order shows no pay button', async () => {
    for (const status of ['paid', 'abandoned', 'failed']) {
      await sbx.db.query('UPDATE orders SET status = $2 WHERE order_ref = $1', [ref, status]);
      const v = await resolveHandoff(sbx, owner, ref);
      expect(v, status).toMatchObject({ kind: 'show', can_pay: false });
    }
    await sbx.db.query("UPDATE orders SET status = 'created' WHERE order_ref = $1", [ref]);
  });

  it('an order the buyer never approves gives its reservation back when the order is abandoned', async () => {
    await sbx.db.query("UPDATE orders SET status = 'abandoned' WHERE order_ref = $1", [ref]);
    const r = await tool(agent.token, 'check_budget');
    expect(r.out).toMatchObject({
      status: 'active',
      remaining_count: 3,
      remaining_total_minor: 10_000,
    });
    expect(
      await rows(sbx, "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'"),
    ).toBe(0);
  });

  it('three unapproved orders fill a 3-purchase cap, so the cap is not an open door', async () => {
    const a = await newAgent(sbx, owner, { mandate: { max_count: 3 } });
    const codes = await extraOffers(sbx, {
      publisher: H,
      from: 'tide-tables',
      count: 4,
      price_minor: 20,
      prefix: 'sbx',
    });
    const rs = [];
    for (const c of codes) rs.push(await tool(a.token, 'buy_unit', buyArgs(H, c)));
    expect(statuses(rs)).toEqual([
      'buyer_approval_required',
      'buyer_approval_required',
      'buyer_approval_required',
      'cap_exhausted',
    ]);
    expect(
      await rows(
        sbx,
        'SELECT count(*) AS c FROM provider_orders WHERE provider_order_id IS NOT NULL',
      ),
    ).toBe(0);
  });
});
