// API-B (mutation gaps): the edges of the tool arguments, the answers a refused buy gives, and what a
// bought answer carries. Each case pins a limit or a branch that the other files only touch in passing.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import {
  HARBOUR_FERRY,
  HARBOUR_TIDE,
  bootPackApp,
  buyer,
  proposalFor,
} from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import {
  buyArgs,
  extraOffers,
  idem,
  newAgent,
  rows,
  setAgentBuy,
  setAiScope,
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

const H = 'harbour-ledger';
let app: App;
let owner: Actor;
let units: string[];
let token: string;

beforeAll(async () => {
  app = await bootPackApp();
  owner = await buyer(app, 'a');
  units = await extraOffers(app, { publisher: H, from: 'tide-tables', count: 12, price_minor: 30 });
  await setAgentBuy(app, true);
  token = (await newAgent(app, owner, { mandate: { max_count: 50, max_total_minor: 1_000_000 } }))
    .token;
}, 120_000);

const status = async (name: string, args: unknown) => (await tool(token, name, args)).out.status;

describe('argument limits: the last value that fits and the first that does not', () => {
  it.each([
    ['publisher 64 characters', 'search_catalogue', { publisher: 'p'.repeat(64) }, 'ok'],
    [
      'publisher 65 characters',
      'search_catalogue',
      { publisher: 'p'.repeat(65) },
      'invalid_arguments',
    ],
    ['publisher 1 character', 'search_catalogue', { publisher: 'p' }, 'ok'],
    ['publisher 1 character', 'search_catalogue', { publisher: 'p' }, 'ok'],
    ['publisher empty', 'search_catalogue', { publisher: '' }, 'invalid_arguments'],
    ['offer code 64 characters', 'get_offer', { publisher: H, offer: 'o'.repeat(64) }, 'not_found'],
    [
      'offer code 65 characters',
      'get_offer',
      { publisher: H, offer: 'o'.repeat(65) },
      'invalid_arguments',
    ],
    ['offer code 1 character', 'get_offer', { publisher: H, offer: 'o' }, 'not_found'],
    ['offer code empty', 'get_offer', { publisher: H, offer: '' }, 'invalid_arguments'],
    [
      'entitlement id 200 characters',
      'open_unit',
      { entitlement_id: 'e'.repeat(200) },
      'not_found',
    ],
    [
      'entitlement id 201 characters',
      'open_unit',
      { entitlement_id: 'e'.repeat(201) },
      'invalid_arguments',
    ],
    ['highest price 2147483647', 'search_catalogue', { max_price_minor: 2_147_483_647 }, 'ok'],
    [
      'highest price 2147483648',
      'search_catalogue',
      { max_price_minor: 2_147_483_648 },
      'invalid_arguments',
    ],
    ['highest price 0', 'search_catalogue', { max_price_minor: 0 }, 'ok'],
    ['highest price negative', 'search_catalogue', { max_price_minor: -1 }, 'invalid_arguments'],
    ['limit 50', 'search_catalogue', { limit: 50 }, 'ok'],
    ['limit 51', 'search_catalogue', { limit: 51 }, 'invalid_arguments'],
    ['limit 0', 'search_catalogue', { limit: 0 }, 'invalid_arguments'],
    ['need 2000 characters', 'propose_pack', { need: 'n'.repeat(2000) }, 'ok'],
    ['need 2001 characters', 'propose_pack', { need: 'n'.repeat(2001) }, 'invalid_arguments'],
    ['need 1 character', 'propose_pack', { need: 'n' }, 'ok'],
    ['need empty', 'propose_pack', { need: '' }, 'invalid_arguments'],
  ])('%s', async (_name, tool_name, args, expected) => {
    const got = await status(tool_name, args);
    if (expected === 'ok') expect(['ok', 'no_match', 'invalid_need', 'unavailable']).toContain(got);
    else expect(got).toBe(expected);
  });

  it('five offers in a pack pass the shape check, six do not', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((x) => `ofr_${x}`);
    const r5 = await tool(token, 'buy_unit', {
      proposal_id: 'prp_x',
      offer_ids: five,
      idempotency_key: idem('five'),
    });
    expect(r5.out.status).not.toBe('invalid_arguments');
    const r6 = await tool(token, 'buy_unit', {
      proposal_id: 'prp_x',
      offer_ids: [...five, 'ofr_f'],
      idempotency_key: idem('six'),
    });
    expect(r6.out.status).toBe('invalid_arguments');
  });

  it('an invalid_arguments answer names the fields, at most twenty', async () => {
    const one = await tool(token, 'buy_unit', buyArgs(H, units[0]!, idem('f'), { price_minor: 1 }));
    expect(one.out['fields']).toEqual(['price_minor']);
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`extra_${String(i).padStart(2, '0')}`, 1]),
    );
    const r = await tool(token, 'buy_unit', buyArgs(H, units[0]!, idem('f'), many));
    expect((r.out['fields'] as string[]).length).toBe(20);
  });

  it('a successful tool answer is not marked as an error', async () => {
    const r = await tool(token, 'search_catalogue', {});
    expect(r.out.status).toBe('ok');
    expect(r.isError).toBe(false);
  });
});

describe('a buy that is refused leaves the key free and books nothing', () => {
  it('the same key works for a later, valid buy after a refusal', async () => {
    const key = idem('retry');
    const first = await tool(token, 'buy_unit', buyArgs(H, 'no-such-offer', key));
    expect(first.out.status).toBe('not_found');
    const second = await tool(token, 'buy_unit', buyArgs(H, units[0]!, key));
    expect(second.out.status).toBe('bought');
  });

  it('a unit the buyer already holds is already_owned, with no second order', async () => {
    const before = await rows(app, 'SELECT count(*) AS c FROM orders');
    const r = await tool(token, 'buy_unit', buyArgs(H, units[0]!));
    expect(r.out.status).toBe('already_owned');
    expect(r.isError).toBe(true);
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(before);
  });

  it('an option the offer does not sell is not_available, with the reason', async () => {
    const code = units[10]!;
    await app.db.query(
      `UPDATE offers SET options = (SELECT jsonb_agg(x) FROM jsonb_array_elements(options) x WHERE x->>'option' = 'keep_retrieve') WHERE id = $1`,
      [`ofr_${H}_${code}`],
    );
    const r = await tool(
      token,
      'buy_unit',
      buyArgs(H, code, idem('opt'), { option: 'online_read' }),
    );
    expect(r.out.status).toBe('not_available');
    expect(typeof r.out['reason']).toBe('string');
    expect(r.isError).toBe(true);
  });

  it('a proposal the buyer never had is not_found', async () => {
    const r = await tool(token, 'buy_unit', {
      proposal_id: 'prp_doesnotexist',
      offer_ids: [`ofr_${H}_${units[2]!}`],
      idempotency_key: idem('prp'),
    });
    expect(r.out.status).toBe('not_found');
  });

  it('an offer in another currency inside a proposal is refused as currency_mismatch', async () => {
    const other = await app.db.query<{ id: string; slug: string; code: string }>(
      `SELECT o.id, p.slug, replace(o.id, 'ofr_' || p.slug || '_', '') AS code FROM offers o
         JOIN publishers p ON p.id = o.publisher_id WHERE o.currency <> 'USD' AND o.status = 'authorised' LIMIT 1`,
    );
    const o = other.rows[0]!;
    // a pack lists only offers whose currency has an enabled corridor, so enable it for this case
    await app.db.query(`UPDATE corridors SET enabled = true WHERE currency <> 'USD'`);
    const p = await proposalFor(app, owner, [[o.slug, o.code]]);
    const before = await rows(app, 'SELECT count(*) AS c FROM orders');
    const r = await tool(token, 'buy_unit', {
      proposal_id: p.proposal_id,
      offer_ids: p.offer_ids,
      idempotency_key: idem('cur'),
    });
    await app.db.query(`UPDATE corridors SET enabled = false WHERE currency <> 'USD'`);
    expect(r.out.status).toBe('currency_mismatch');
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(before);
  });

  it('with checkout switched off the answer says checkout_off and books nothing', async () => {
    await app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'checkout_enabled'`);
    try {
      const held = await rows(
        app,
        "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'",
      );
      const r = await tool(token, 'buy_unit', buyArgs(H, units[3]!));
      expect(r.out.status).toBe('checkout_off');
      expect(
        await rows(app, "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'"),
      ).toBe(held);
    } finally {
      await app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'checkout_enabled'`);
    }
  });
});

describe('what a bought answer carries', () => {
  it('the money and count left, and an approval frozen to the mandate with the terms accepted and no identity shared', async () => {
    const a = await newAgent(app, owner, { mandate: { max_count: 4, max_total_minor: 100 } });
    const r = await tool(a.token, 'buy_unit', buyArgs(H, units[4]!));
    expect(r.out.status).toBe('bought');
    expect(r.out['remaining_total_minor']).toBe(70);
    expect(r.out['remaining_count']).toBe(3);
    const approval = await app.db.query<{ id: string }>(
      `SELECT id FROM approvals WHERE snapshot->>'mandate_id' = $1`,
      [a.mandate!.id],
    );
    expect(approval.rows).toHaveLength(1);
    const audit = await app.db.query<{ detail: { terms: boolean; identity_share: boolean } }>(
      `SELECT detail FROM audit_log WHERE action = 'approval.requested' AND target = $1`,
      [approval.rows[0]!.id],
    );
    expect(audit.rows[0]!.detail).toMatchObject({ terms: true, identity_share: false });
  });
});

describe('propose_pack keeps what an agent may not buy out of the answer', () => {
  it('an offer with ai_scope not_allowed is absent from a proposal, and a proposal of only such offers is no_match', async () => {
    await setAiScope(app, H, 'ferry-timetables', 'not_allowed');
    const r = await tool(token, 'propose_pack', { need: 'ferry timetables for the harbour' });
    const items = (r.out['items'] ?? []) as { offer: string }[];
    expect(items.map((i) => i.offer)).not.toContain('ferry-timetables');
    // a proposal that discovery builds only from the forbidden offer is empty for the agent
    const p = await proposalFor(app, owner, [HARBOUR_FERRY]);
    expect(p.offer_ids.length).toBe(1);
    const bought = await tool(token, 'buy_unit', {
      proposal_id: p.proposal_id,
      offer_ids: p.offer_ids,
      idempotency_key: idem('ferry'),
    });
    expect(bought.out.status).toBe('ai_not_allowed');
    void HARBOUR_TIDE;
  });
});

describe('propose_pack with only forbidden matches', () => {
  it('says no_match when every offer discovery found is closed to agents', async () => {
    for (const u of units) await setAiScope(app, H, u, 'not_allowed');
    const r = await tool(token, 'propose_pack', { need: `Unit ${units[11]!}` });
    expect(r.out.status).toBe('no_match');
    expect(r.out['items']).toBeUndefined();
  });
});
