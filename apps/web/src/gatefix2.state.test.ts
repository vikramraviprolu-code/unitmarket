// GATEFIX2 items 3 and 7 over the real engine (docs/specs/fix-gatefinal.md): an open unpaid order is named as
// that, not as "in your library"; a paid article still says it is owned; cancelling lets the buyer buy again;
// the offer page says whether it is on sale from stored data. Offline app (PGlite, dry-run transport).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootTestApp, call, signIn } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

let app: App;
let A: Session;
let actorA: Actor;
let actorB: Actor;
let quotesRoute: typeof import('./app/api/quotes/route');

beforeAll(async () => {
  app = await bootTestApp();
  const sessionRoute = await import('./app/api/session/route');
  quotesRoute = await import('./app/api/quotes/route');
  A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  const who = async (p: string): Promise<Actor> => {
    const row = await app.db.query<{ id: string }>('SELECT id FROM buyers WHERE auth_subject = $1', [
      `persona:${p}`,
    ]);
    return { kind: 'buyer', buyer_id: row.rows[0]!.id };
  };
  actorA = await who('buyer-a');
  actorB = await who('buyer-b');
});
afterAll(async () => {
  await app.close();
});

const PUB = 'harbour-ledger';
const quoteOf = (offer: string, actor: Actor) =>
  app.engine.quote({
    offer: { publisher_slug: PUB, offer_code: offer },
    actor,
    source: 'direct',
  });

async function openOrder(actor: Actor, offer: string): Promise<{ order_ref: string; order_id: string }> {
  const page = await app.engine.offerPage({ publisher: PUB, offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: PUB, offer_code: offer },
    actor,
    source: 'direct',
    option: page!.options[0]!.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error('place failed');
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error('checkout failed');
  return placed.value;
}

const reasonOf = (q: Awaited<ReturnType<typeof quoteOf>>): string | null =>
  q.ok && q.value.kind === 'no_match' ? q.value.reason : null;

describe('an open unpaid order (item 3)', () => {
  it('says unpaid_order, names the order, and the library item links to it', async () => {
    const o = await openOrder(actorA, 'tide-tables');
    expect(reasonOf(await quoteOf('tide-tables', actorA))).toBe('unpaid_order');
    expect(
      await app.engine.unpaidOrderRef({ publisher: PUB, offer: 'tide-tables', actor: actorA }),
    ).toBe(o.order_ref);
    // another buyer has no such order, and another article of the same buyer has none either
    expect(
      await app.engine.unpaidOrderRef({ publisher: PUB, offer: 'tide-tables', actor: actorB }),
    ).toBeNull();
    expect(
      await app.engine.unpaidOrderRef({ publisher: PUB, offer: 'ferry-timetables', actor: actorA }),
    ).toBeNull();
    const lib = await app.engine.library({ actor: actorA });
    const item = lib.find((i) => i.order_id === o.order_id)!;
    expect(item.order_ref).toBe(o.order_ref);

    // the quotes route carries the order ref beside the reason, and only for this reason
    const res = await call(quotesRoute.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      body: { publisher: PUB, offer: 'tide-tables' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'no_match',
      reason: 'unpaid_order',
      order_ref: o.order_ref,
    });
  });

  it('cancelling it lets the buyer ask for a price again', async () => {
    const open = await app.db.query<{ id: string }>(
      `SELECT id FROM orders WHERE status = 'awaiting_buyer' AND buyer_id = $1`,
      [actorA.kind === 'buyer' ? actorA.buyer_id : ''],
    );
    for (const r of open.rows)
      expect((await app.engine.payments.cancelOrder({ order_id: r.id, actor: actorA })).ok).toBe(
        true,
      );
    const q = await quoteOf('tide-tables', actorA);
    expect(q.ok && q.value.kind).toBe('quote');
    expect(
      await app.engine.unpaidOrderRef({ publisher: PUB, offer: 'tide-tables', actor: actorA }),
    ).toBeNull();
  });

  it('a paid article is still already_owned, with no unpaid order to point to', async () => {
    const o = await openOrder(actorA, 'ferry-timetables');
    expect(
      await app.engine.dryRunApprove({ order_ref: o.order_ref, actor: actorA, scenario: 'happy' }),
    ).toBe(true);
    await app.engine.payments.onBuyerReturn({
      order_ref: o.order_ref,
      actor: actorA,
      scenario: 'happy',
    });
    expect(reasonOf(await quoteOf('ferry-timetables', actorA))).toBe('already_owned');
    expect(
      await app.engine.unpaidOrderRef({ publisher: PUB, offer: 'ferry-timetables', actor: actorA }),
    ).toBeNull();
    const res = await call(quotesRoute.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      body: { publisher: PUB, offer: 'ferry-timetables' },
    });
    expect(await res.json()).toEqual({ kind: 'no_match', reason: 'already_owned' });
  });
});

describe('the offer page knows whether it is on sale (item 7)', () => {
  it('on sale while the publisher is active, not on sale while it is suspended', async () => {
    expect((await app.engine.offerPage({ publisher: PUB, offer: 'knot-notebook' }))!.on_sale).toBe(
      true,
    );
    await app.db.query(`UPDATE publishers SET status = 'suspended' WHERE slug = $1`, [PUB]);
    try {
      expect(
        (await app.engine.offerPage({ publisher: PUB, offer: 'knot-notebook' }))!.on_sale,
      ).toBe(false);
    } finally {
      await app.db.query(`UPDATE publishers SET status = 'active' WHERE slug = $1`, [PUB]);
    }
    expect((await app.engine.offerPage({ publisher: PUB, offer: 'knot-notebook' }))!.on_sale).toBe(
      true,
    );
  });
});
