// API-W0 (F5): one facade per stakeholder over the real Engine on PGlite. A facade checks the actor kind
// first and answers forbidden for the wrong one; it then calls the Engine and adds no rule of its own.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor, Principal } from '@umsbx/contracts';
import { toActor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../composite-support';
import { createApiV1, type ApiV1 } from '../../composition.server';
import type { App } from '../../composition.server';
import { expectOffline } from './offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

let app: App;
let api: ApiV1;
let buyerA: Actor;
let buyerB: Actor;
let harbour: Actor;
let quayside: Actor;
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_w0', mfa: true };

beforeAll(async () => {
  app = await bootPackApp();
  api = createApiV1(app);
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  const pub = async (slug: string): Promise<Actor> => ({
    kind: 'publisher',
    publisher_id: (
      await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
    ).rows[0]!.id,
  });
  harbour = await pub('harbour-ledger');
  quayside = await pub('quayside-gazette');
});

const agentOf = (actor: Actor): Principal => {
  if (actor.kind !== 'buyer') throw new Error('buyer expected');
  return { kind: 'agent', key_id: 'key_f5', buyer_id: actor.buyer_id, mandate_id: null };
};
const clientOf = (owner: Actor): Principal => {
  if (owner.kind === 'system') throw new Error('no system owner');
  return { kind: 'api_client', key_id: 'key_f5c', owner };
};

describe('the facades are wired once from the app', () => {
  it('createApiV1 returns the four facades, the outbox and the webhook service, and the same object for the same app', () => {
    // API-C adds `webhooks` (the subscription service behind /api/v1/webhook-subscriptions).
    expect(Object.keys(api).sort()).toEqual([
      'agent',
      'buyer',
      'events',
      'ops',
      'seller',
      'webhooks',
    ]);
    expect(createApiV1(app)).toBe(api);
  });
});

describe('buyer facade', () => {
  it('lists the catalogue from the real Engine for a buyer', async () => {
    const r = await api.buyer.catalogue(buyerA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const direct = await app.engine.listOffers();
    expect(r.value.map((o) => o.offer_id)).toEqual(direct.map((o) => o.offer_id));
    expect(r.value.length).toBeGreaterThan(0);
  });

  it('reads the library of the buyer and nobody else', async () => {
    const a = await api.buyer.library(buyerA);
    const b = await api.buyer.library(buyerB);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(a.value).toEqual(await app.engine.library({ actor: buyerA }));
  });

  it('answers not_found for an order that is not the buyer own, without saying whose it is', async () => {
    const r = await api.buyer.order(buyerA, 'ord_doesnotexist');
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('refuses a publisher, an operator and the system actor with forbidden, before the Engine is called', async () => {
    const spy = vi.spyOn(app.engine, 'listOffers');
    for (const actor of [harbour, OPERATOR, { kind: 'system' } as Actor]) {
      expect(await api.buyer.catalogue(actor), actor.kind).toEqual({
        ok: false,
        error: { code: 'forbidden' },
      });
      expect(await api.buyer.library(actor), actor.kind).toEqual({
        ok: false,
        error: { code: 'forbidden' },
      });
      expect(await api.buyer.order(actor, 'ord_x'), actor.kind).toEqual({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('seller facade', () => {
  it('returns the publisher home and sales from the real Engine for a publisher', async () => {
    const home = await api.seller.home(harbour);
    expect(home.ok).toBe(true);
    if (home.ok) expect(home.value).toEqual(await app.engine.publisherHome(harbour));
    const sales = await api.seller.sales(harbour);
    expect(sales.ok).toBe(true);
  });

  it('shows each publisher only its own home', async () => {
    const h = await api.seller.home(harbour);
    const q = await api.seller.home(quayside);
    expect(h.ok && q.ok).toBe(true);
    if (h.ok && q.ok) expect(h.value.display_name).not.toBe(q.value.display_name);
  });

  it('refuses a buyer and an operator with forbidden', async () => {
    for (const actor of [buyerA, OPERATOR]) {
      expect(await api.seller.home(actor), actor.kind).toEqual({
        ok: false,
        error: { code: 'forbidden' },
      });
      expect(await api.seller.sales(actor), actor.kind).toEqual({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
  });
});

describe('ops facade', () => {
  it('returns the operations snapshot for an operator and refuses everyone else', async () => {
    const r = await api.ops.snapshot(OPERATOR);
    expect(r.ok).toBe(true);
    for (const actor of [buyerA, harbour, { kind: 'system' } as Actor]) {
      expect(await api.ops.snapshot(actor), actor.kind).toEqual({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
  });

  it('an operator key (mapped to mfa false) is still an operator: it may read', async () => {
    const mapped = toActor(clientOf({ kind: 'operator', operator_id: 'opr_w0', mfa: true }));
    expect(mapped).toEqual({ kind: 'operator', operator_id: 'opr_w0', mfa: false });
    expect((await api.ops.snapshot(mapped)).ok).toBe(true);
  });

  it('has no method that changes a switch, starts or stops PayPal, or approves anything', () => {
    expect(Object.keys(api.ops).sort()).toEqual(['snapshot']);
  });
});

describe('agent facade', () => {
  it('reads the catalogue and library for the buyer behind an agent principal', async () => {
    const cat = await api.agent.catalogue(agentOf(buyerA));
    expect(cat.ok).toBe(true);
    const lib = await api.agent.library(agentOf(buyerA));
    expect(lib.ok).toBe(true);
  });

  it('refuses a principal that is not an agent, including an api_client owned by a buyer', async () => {
    const r = await api.agent.catalogue(clientOf(buyerA));
    expect(r).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('an agent sees the buyer it acts for and no other buyer order', async () => {
    const r = await api.agent.order(agentOf(buyerA), 'ord_of_buyer_b');
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('has read methods only in W0: nothing that buys, approves or opens a mandate', () => {
    expect(Object.keys(api.agent).sort()).toEqual(['catalogue', 'library', 'order']);
  });
});

describe('an api_client reaches only the methods of its owner kind', () => {
  it('owned by a publisher: seller methods work, buyer and ops methods are forbidden', async () => {
    const actor = toActor(clientOf(harbour));
    expect((await api.seller.home(actor)).ok).toBe(true);
    expect(await api.buyer.catalogue(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await api.buyer.library(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await api.ops.snapshot(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('owned by a buyer: buyer methods work, seller and ops methods are forbidden', async () => {
    const actor = toActor(clientOf(buyerA));
    expect((await api.buyer.catalogue(actor)).ok).toBe(true);
    expect(await api.seller.home(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await api.ops.snapshot(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('owned by an operator: ops reads work, buyer and seller methods are forbidden', async () => {
    const actor = toActor(clientOf(OPERATOR));
    expect((await api.ops.snapshot(actor)).ok).toBe(true);
    expect(await api.buyer.catalogue(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await api.seller.home(actor)).toEqual({ ok: false, error: { code: 'forbidden' } });
  });
});
