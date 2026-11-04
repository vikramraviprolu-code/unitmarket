// API-B evals E-B1 to E-B4: a scripted agent (no model call, no network) talks to the MCP route the way a
// real agent would, and the cap is the thing under test. The loop is deliberately naive: it keeps buying
// until the server says stop, so any gap in the cap shows as an extra purchase.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline, offlineTrace } from '../../../../api-v1/offline-guard';
import {
  bootSandboxApp,
  buyArgs,
  extraOffers,
  idem,
  newAgent,
  rows,
  setAgentBuy,
  tool,
} from './agent-test-support';
import type { ToolOut } from './agent-test-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

const H = 'harbour-ledger';

/** The scripted agent: read the budget, search, then buy offer after offer until a buy is not `bought`. */
async function runAgent(
  token: string,
  offers: string[],
): Promise<{ log: string[]; results: ToolOut[] }> {
  const log: string[] = [];
  const results: ToolOut[] = [];
  const budget = await tool(token, 'check_budget');
  log.push(`check_budget:${budget.out.status}`);
  if (budget.out.status !== 'active') return { log, results };
  const found = await tool(token, 'search_catalogue', { publisher: H, limit: 5 });
  log.push(`search_catalogue:${found.out.status}`);
  for (const offer of offers) {
    const r = await tool(token, 'buy_unit', buyArgs(H, offer, idem('eval')));
    results.push(r);
    log.push(`buy_unit:${r.out.status}`);
    if (r.out.status !== 'bought') break;
  }
  return { log, results };
}

describe('dry-run environment', () => {
  let app: App;
  let owner: Actor;
  let offers: string[];
  beforeAll(async () => {
    app = await bootPackApp();
    owner = await buyer(app, 'a');
    offers = await extraOffers(app, {
      publisher: H,
      from: 'tide-tables',
      count: 60,
      price_minor: 10,
    });
    await setAgentBuy(app, true);
  }, 180_000);

  it('E-B1: a $5.00 cap with 10-cent units buys exactly 50, then cap_exhausted', async () => {
    const a = await newAgent(app, owner, { mandate: { max_total_minor: 500 } });
    const { log, results } = await runAgent(a.token, offers);
    expect(results.filter((r) => r.out.status === 'bought')).toHaveLength(50);
    expect(results).toHaveLength(51);
    expect(results[50]!.out.status).toBe('cap_exhausted');
    expect(results[50]!.isError).toBe(true);
    expect(log.slice(0, 2)).toEqual(['check_budget:active', 'search_catalogue:ok']);
    const left = await tool(a.token, 'check_budget');
    expect(left.out).toMatchObject({ status: 'active', remaining_total_minor: 0 });
    const spent = await rows(
      app,
      "SELECT coalesce(sum(amount_minor), 0) AS c FROM mandate_reservations r JOIN mandates m ON m.id = r.mandate_id WHERE m.agent_key_id = $1 AND r.state = 'committed'",
      [a.key_id],
    );
    expect(spent).toBe(500);
    // the mandate.exhausted event is written once, with the money reason
    expect(
      await rows(
        app,
        "SELECT count(*) AS c FROM event_outbox WHERE type = 'mandate.exhausted' AND payload->>'agent_key_id' = $1",
        [a.key_id],
      ),
    ).toBe(1);
    expect(
      await rows(
        app,
        "SELECT count(*) AS c FROM event_outbox WHERE type = 'mandate.exhausted' AND payload->>'agent_key_id' = $1 AND payload->>'reason' = 'money'",
        [a.key_id],
      ),
    ).toBe(1);
  });

  it('E-B2: with no mandate the agent is told to ask the buyer, naming money, purchases and expiry', async () => {
    const a = await newAgent(app, owner, { mandate: null });
    const ordersBefore = await rows(app, 'SELECT count(*) AS c FROM orders');
    const { log, results } = await runAgent(a.token, offers.slice(0, 3));
    expect(log).toEqual(['check_budget:mandate_required']);
    expect(results).toEqual([]);
    const budget = await tool(a.token, 'check_budget');
    const ask = String(budget.out['ask_buyer']).toLowerCase();
    for (const word of ['money', 'purchases', 'expir']) expect(ask).toContain(word);
    const buyNow = await tool(a.token, 'buy_unit', buyArgs(H, offers[0]!));
    expect(buyNow.out.status).toBe('mandate_required');
    expect(buyNow.isError).toBe(true);
    expect(String(buyNow.out['ask_buyer']).toLowerCase()).toContain('purchases');
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(ordersBefore);
  });

  it('E-B3: a 3-purchase cap with a large money cap buys exactly 3', async () => {
    const a = await newAgent(app, owner, { mandate: { max_count: 3, max_total_minor: 1_000_000 } });
    const spare = offers.slice(50); // E-B1 already bought the first 50, and a buyer holds each article once
    const { results } = await runAgent(a.token, spare);
    expect(results.map((r) => r.out.status)).toEqual([
      'bought',
      'bought',
      'bought',
      'cap_exhausted',
    ]);
    expect(await tool(a.token, 'check_budget')).toMatchObject({ out: { remaining_count: 0 } });
    expect(
      await rows(
        app,
        "SELECT count(*) AS c FROM event_outbox WHERE type = 'mandate.exhausted' AND payload->>'agent_key_id' = $1 AND payload->>'reason' = 'count'",
        [a.key_id],
      ),
    ).toBe(1);
  });
});

describe('E-B4: sandbox environment', () => {
  let sbx: App;
  let dir: string;
  let owner: Actor;
  beforeAll(async () => {
    ({ app: sbx, dir } = await bootSandboxApp());
    owner = await buyer(sbx, 'a');
    await setAgentBuy(sbx, true);
  }, 180_000);
  afterAll(async () => {
    await sbx?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('buy_unit returns buyer_approval_required with a UnitMarket link and makes zero transport calls', async () => {
    const a = await newAgent(sbx, owner, { mandate: { max_count: 2, max_total_minor: 10_000 } });
    const r = await tool(a.token, 'buy_unit', buyArgs(H, 'tide-tables'));
    expect(r.out.status).toBe('buyer_approval_required');
    expect(String(r.out['checkout_url'])).toMatch(
      /^http:\/\/localhost:3000\/buy\/agent\/[A-Za-z0-9_-]+$/,
    );
    expect(JSON.stringify(r.out)).not.toMatch(/paypal|approve/i);
    expect(offlineTrace.calls).toEqual([]);
    expect(
      await rows(
        sbx,
        'SELECT count(*) AS c FROM provider_orders WHERE provider_order_id IS NOT NULL',
      ),
    ).toBe(0);
    // placing an order stores one prepared `create` plan, as for any order; nothing was sent or confirmed
    expect(await rows(sbx, "SELECT count(*) AS c FROM operations WHERE state <> 'prepared'")).toBe(
      0,
    );
  });
});
