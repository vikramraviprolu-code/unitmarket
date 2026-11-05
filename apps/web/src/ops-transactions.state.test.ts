// INT-SR1 (SR1.3): the operator transaction list with four saved views, through two routes. The key route
// (GET /api/v1/ops/transactions, scope ops:read) is identity free: order refs, amounts, states, flags and
// opaque ids, no buyer or seller name and no PayPal id. The session route (GET /api/ops/transactions) adds
// those only when the session has MFA; the single helper is src/server/ops-identity.ts. views-seed gives
// Needs attention 4, Refunds today 2, Agent purchases 5 and Sandbox only 3.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { VIEWS_EXPECTED, VIEWS_MEMBERS } from '../composition.server';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json } from './search-support';
import type { Handler, SearchRig, Sess } from './search-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const VIEWS = Object.keys(VIEWS_EXPECTED) as (keyof typeof VIEWS_EXPECTED)[];
const IDENTITY_WORDS = [
  'Vera Viewer',
  'Wes Watcher',
  'Quay Views',
  'vs-quay',
  'PAYPALVS',
  'CAP_vs_u',
  'buyer_display_name',
  'seller_name',
  'provider_order_id',
  'capture_id',
];

let rig: SearchRig;
let key: string;
let mfa: Sess;
let noMfa: Sess;
let keyRoute: Handler;
let sessionRoute: Handler;

beforeAll(async () => {
  rig = await bootSearch();
  key = await rig.key(rig.operator, ['ops:read']);
  mfa = await rig.session(rig.operator);
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_nomfa', mfa: false });
  keyRoute = (await import('./app/api/v1/ops/transactions/route')).GET as Handler;
  sessionRoute = (await import('./app/api/ops/transactions/route')).GET as Handler;
});

const viaKey = async (qs: string) => {
  const res = await rig.v1(keyRoute, key, { url: `/api/v1/ops/transactions${qs}` });
  return {
    res,
    body: await json<{ items: Record<string, unknown>[]; next_cursor: string | null }>(res),
  };
};
const viaSession = async (s: Sess, qs: string) => {
  const res = await rig.old(sessionRoute, s, { url: `/api/ops/transactions${qs}` });
  return {
    res,
    body: await json<{ items: Record<string, unknown>[]; next_cursor: string | null }>(res),
  };
};
const units = (items: Record<string, unknown>[]) => items.map((i) => String(i['unit_id'])).sort();

describe('SR1.3 saved views', () => {
  it.each(VIEWS)('%s holds the lines views-seed puts in it (key route)', async (view) => {
    const { res, body } = await viaKey(`?view=${view}`);
    expect(res.status).toBe(200);
    expect(units(body.items)).toEqual([...VIEWS_MEMBERS[view]].sort());
    expect(body.items).toHaveLength(VIEWS_EXPECTED[view]);
    expect(body.next_cursor).toBeNull();
  });

  it('the session route gives the same lines', async () => {
    for (const view of VIEWS) {
      const { body } = await viaSession(mfa, `?view=${view}`);
      expect(units(body.items)).toEqual([...VIEWS_MEMBERS[view]].sort());
    }
  });

  it('a view and a filter are ANDed', async () => {
    const { body } = await viaKey('?view=agent_purchases&environment=sandbox');
    expect(units(body.items)).toEqual(['vs_u9']);
  });

  it('an unknown view is dropped, not an error', async () => {
    const { res, body } = await viaKey('?view=bogus&limit=3');
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(3);
  });

  it('every line carries its status word and the order ref', async () => {
    const { body } = await viaKey('?view=needs_attention');
    for (const i of body.items) {
      expect(i['status']).toBe('attention');
      expect(String(i['order_ref'])).toMatch(/^ref_vs_o\d+$/);
    }
  });
});

describe('SR1.3 identity', () => {
  it('the key answer has no name and no provider id anywhere (deep scan)', async () => {
    for (const view of VIEWS) {
      const { res, body } = await viaKey(`?view=${view}`);
      const text = JSON.stringify(body);
      expect(res.status).toBe(200);
      for (const w of IDENTITY_WORDS) expect(text).not.toContain(w);
    }
    const all = await viaKey('?limit=100');
    for (const w of IDENTITY_WORDS) expect(JSON.stringify(all.body)).not.toContain(w);
  });

  it('the key route takes opaque ids for buyer and seller, never names', async () => {
    const byId = await viaKey('?buyer=vs_b2&limit=100');
    expect(byId.body.items.length).toBeGreaterThan(0);
    // B4 (C3): the key may filter by the opaque buyer id, but no line carries it back.
    for (const i of byId.body.items) expect(i).not.toHaveProperty('buyer_id');
    const byName = await viaKey('?buyer=Wes&limit=100');
    expect(byName.body.items).toEqual([]);
    const bySeller = await viaKey('?seller=Quay&limit=100');
    expect(bySeller.body.items).toEqual([]);
  });

  it('a session with MFA sees buyer and seller names and PayPal ids', async () => {
    const { res, body } = await viaSession(mfa, '?view=agent_purchases');
    expect(res.status).toBe(200);
    for (const i of body.items) {
      expect(i['buyer_display_name']).toBe('Wes Watcher');
      expect(i['seller_name']).toBe('Quay Views');
      expect(String(i['provider_order_id'])).toMatch(/^PAYPALVS/);
    }
    const byName = await viaSession(mfa, '?buyer=Wes&limit=100');
    expect(byName.body.items.length).toBeGreaterThan(0);
  });

  it('a session without MFA gets the key answer: no names, no ids, no name matching', async () => {
    const { res, body } = await viaSession(noMfa, '?view=agent_purchases');
    expect(res.status).toBe(200);
    expect(units(body.items)).toEqual([...VIEWS_MEMBERS.agent_purchases].sort());
    for (const w of IDENTITY_WORDS) expect(JSON.stringify(body)).not.toContain(w);
    const byName = await viaSession(noMfa, '?buyer=Wes&limit=100');
    expect(byName.body.items).toEqual([]);
  });
});

describe('SR1.3 paging', () => {
  it('a plain call lists all lines; a limit pages with a cursor bound to the query', async () => {
    const all = await viaKey('');
    expect(all.body.items.length).toBeGreaterThanOrEqual(11);
    expect(all.body.next_cursor).toBeNull();
    const p1 = await viaKey('?limit=4');
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.next_cursor).not.toBeNull();
    const p2 = await viaKey(`?limit=4&cursor=${p1.body.next_cursor!}`);
    expect(p2.body.items).toHaveLength(4);
    expect(units(p2.body.items).some((u) => units(p1.body.items).includes(u))).toBe(false);
    const other = await viaKey(`?limit=4&status=paid&cursor=${p1.body.next_cursor!}`);
    expect(other.res.status).toBe(400);
  });
});

describe('SR1.3 handler refusals', () => {
  it('a buyer gets 403 from quick-find; a system actor gets 403 from the list and the export', async () => {
    const { opsExportFor, opsFind, opsTransactionsFor } = await import('./api-v1/ops');
    const system: Actor = { kind: 'system' };
    for (const r of [
      await opsFind(rig.app, rig.buyerA, 'order'),
      await opsTransactionsFor(rig.app, system, {}),
      await opsExportFor(rig.app, system, {}),
    ]) {
      expect(r.status).toBe(403);
      expect((r as { code?: string }).code).toBe('forbidden');
    }
  });

  it('quick-find for an operator answers 200', async () => {
    const { opsFind } = await import('./api-v1/ops');
    expect((await opsFind(rig.app, rig.operator, 'order')).status).toBe(200);
  });
});

describe('SR1.5 quick-find identity', () => {
  it('findForActor drops buyers and seller names without MFA and keeps them with MFA', async () => {
    const { findForActor, hasOpsIdentity } = await import('./server/ops-identity');
    const found = {
      orders: [],
      buyers: [{ id: 'b1', display_name: 'Vera' }],
      sellers: [{ id: 's1', slug: 'quay', display_name: 'Quay' }],
    } as never;
    const keyActor = { kind: 'operator', operator_id: 'o', mfa: false } as Actor;
    const sessionActor = { kind: 'operator', operator_id: 'o', mfa: true } as Actor;
    expect(hasOpsIdentity(keyActor)).toBe(false);
    expect(hasOpsIdentity(sessionActor)).toBe(true);
    expect(hasOpsIdentity(rig.buyerA)).toBe(false);
    expect(findForActor(sessionActor, found)).toBe(found);
    const cut = findForActor(keyActor, found) as unknown as Record<string, unknown>;
    expect(cut['buyers']).toBeUndefined();
    expect(JSON.stringify(cut)).not.toContain('Quay');
    expect(JSON.stringify(cut)).toContain('quay');
  });
});
