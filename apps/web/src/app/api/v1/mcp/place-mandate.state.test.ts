// API-B (opus gate F1): the mandate binding guard in placeOrder (domain/payments/src/place.ts). An approval
// frozen to a mandate can only be placed with that mandate's hold; a hold needs an approval that names its
// mandate; and the hold must belong to the buyer's own agent key. Every refusal books nothing.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { extraOffers, newAgent, rows } from './agent-test-support';

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
let offers: string[];
let next = 0;

beforeAll(async () => {
  app = await bootPackApp();
  owner = await buyer(app, 'a');
  offers = await extraOffers(app, {
    publisher: H,
    from: 'tide-tables',
    count: 10,
    price_minor: 25,
  });
}, 120_000);

/** A fresh offer per case, so an earlier case's open order never blocks a later one. */
async function approvalFor(mandate_id?: string) {
  const offer = offers[next++]!;
  const q = await app.engine.quote({
    offer: { publisher_slug: H, offer_code: offer },
    actor: owner,
    source: 'direct',
  });
  if (!q.ok || q.value.kind === 'no_match') throw new Error(`no quote for ${offer}`);
  const a = await app.engine.requestApproval({
    actor: owner,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
    ...(mandate_id === undefined ? {} : { mandate_id }),
  });
  if (!a.ok) throw new Error(`approval refused: ${a.error.code}`);
  return a.value;
}

const place = (
  a: { approval_id: string; token: string },
  mandate?: { mandate_id: string; agent_key_id: string },
) =>
  app.engine.payments.placeOrder({
    approval_id: a.approval_id,
    token: a.token,
    actor: owner,
    ...(mandate === undefined ? {} : { mandate }),
  });

const untouched = async (mandate_id: string) => {
  expect(
    await rows(app, 'SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1', [
      mandate_id,
    ]),
  ).toBe(0);
  expect(await rows(app, 'SELECT spent_minor AS c FROM mandates WHERE id = $1', [mandate_id])).toBe(
    0,
  );
  expect(await rows(app, 'SELECT used_count AS c FROM mandates WHERE id = $1', [mandate_id])).toBe(
    0,
  );
};

describe('placeOrder: the mandate binding guard', () => {
  it('(a) an approval frozen to a mandate, placed without a hold: mandate_mismatch, no order, no reservation', async () => {
    const agent = await newAgent(app, owner, { mandate: { max_count: 5 } });
    const m = agent.mandate!;
    const approval = await approvalFor(m.id);
    const ordersBefore = await rows(app, 'SELECT count(*) AS c FROM orders');
    const r = await place(approval);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'mandate_refused', reason: 'mandate_mismatch' },
    });
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(ordersBefore);
    await untouched(m.id);
    // the approval was not used up, so the right placement still works
    expect(await place(approval, { mandate_id: m.id, agent_key_id: agent.key_id })).toMatchObject({
      ok: true,
    });
  });

  it('(b) a plain approval placed with a hold: mandate_mismatch, no order, no reservation', async () => {
    const agent = await newAgent(app, owner, { mandate: { max_count: 5 } });
    const m = agent.mandate!;
    const approval = await approvalFor();
    const ordersBefore = await rows(app, 'SELECT count(*) AS c FROM orders');
    const r = await place(approval, { mandate_id: m.id, agent_key_id: agent.key_id });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'mandate_refused', reason: 'mandate_mismatch' },
    });
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(ordersBefore);
    await untouched(m.id);
  });

  it('(c) approval frozen to mandate A, hold for mandate B: mandate_mismatch, neither mandate is touched', async () => {
    const a = await newAgent(app, owner, { mandate: { max_count: 5 } });
    const b = await newAgent(app, owner, { mandate: { max_count: 5 } });
    const approval = await approvalFor(a.mandate!.id);
    const ordersBefore = await rows(app, 'SELECT count(*) AS c FROM orders');
    const r = await place(approval, { mandate_id: b.mandate!.id, agent_key_id: b.key_id });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'mandate_refused', reason: 'mandate_mismatch' },
    });
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(ordersBefore);
    await untouched(a.mandate!.id);
    await untouched(b.mandate!.id);
  });

  it('(d) the right mandate with another agent key of the same buyer: mandate_not_found, nothing booked', async () => {
    const owning = await newAgent(app, owner, { mandate: { max_count: 5 } });
    const other = await newAgent(app, owner, { mandate: null });
    const approval = await approvalFor(owning.mandate!.id);
    const ordersBefore = await rows(app, 'SELECT count(*) AS c FROM orders');
    const r = await place(approval, {
      mandate_id: owning.mandate!.id,
      agent_key_id: other.key_id,
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'mandate_refused', reason: 'mandate_not_found' },
    });
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(ordersBefore);
    await untouched(owning.mandate!.id);
  });

  it('(e) two placements of one agent approval: one order, one reservation kept, the loser gives its room back', async () => {
    const agent = await newAgent(app, owner, { mandate: { max_count: 5 } });
    const m = agent.mandate!;
    const approval = await approvalFor(m.id);
    const ordersBefore = await rows(app, 'SELECT count(*) AS c FROM orders');
    const hold = { mandate_id: m.id, agent_key_id: agent.key_id };
    const results = await Promise.all([place(approval, hold), place(approval, hold)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(await rows(app, 'SELECT count(*) AS c FROM orders')).toBe(ordersBefore + 1);
    const held = (state: string) =>
      rows(
        app,
        'SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1 AND state = $2',
        [m.id, state],
      );
    expect(await held('held')).toBe(1);
    // whatever the loser booked was given back: the counters show one purchase and one price
    expect(await held('released')).toBe(
      (await rows(app, 'SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1', [
        m.id,
      ])) - 1,
    );
    expect(await rows(app, 'SELECT used_count AS c FROM mandates WHERE id = $1', [m.id])).toBe(1);
    expect(await rows(app, 'SELECT spent_minor AS c FROM mandates WHERE id = $1', [m.id])).toBe(25);
    // the kept reservation belongs to the order that exists
    expect(
      await rows(
        app,
        'SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1 AND state = $2 AND order_id IS NOT NULL',
        [m.id, 'held'],
      ),
    ).toBe(1);
  });
});
