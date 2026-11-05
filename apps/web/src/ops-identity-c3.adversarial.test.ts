// FIX-B4 (C3, E2E finding B4): GET /api/v1/ops/transactions must carry no buyer identity. An operator key
// (ops:read) never has the second factor, so its lines leave out `buyer_id` and `agent_key_id`, like the v1
// ops timeline. An operator session with MFA keeps both. The attacks below try to get them back: asking for
// the fields by query, claiming MFA by query or header, adding an MFA session cookie to the bearer call, and
// filtering by the buyer or the key. Keys of another role or tenant get 403. views-seed gives buyer vs_b2
// one agent key `vs_key` and mandate `vs_man`; vs_b1 and vs_b2 are the two buyers.
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
/** Values and field names that identify a buyer or the buyer's agent key. */
const CANARIES = ['vs_b1', 'vs_b2', 'vs_key', '"buyer_id"', '"agent_key_id"'];

let rig: SearchRig;
let opKey: string;
let mfa: Sess;
let noMfa: Sess;
let keyRoute: Handler;
let sessionRoute: Handler;

beforeAll(async () => {
  rig = await bootSearch();
  opKey = await rig.key(rig.operator, ['ops:read']);
  mfa = await rig.session(rig.operator);
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_nomfa_c3', mfa: false });
  keyRoute = (await import('./app/api/v1/ops/transactions/route')).GET as Handler;
  sessionRoute = (await import('./app/api/ops/transactions/route')).GET as Handler;
});

const viaKey = (qs: string, headers: Record<string, string> = {}) =>
  rig.v1(keyRoute, opKey, { url: `/api/v1/ops/transactions${qs}`, headers });
const items = async (r: Response) =>
  (await json<{ items: Record<string, unknown>[] }>(r.clone())).items;
const noCanary = async (r: Response) => {
  const text = await r.clone().text();
  for (const c of CANARIES) expect(text).not.toContain(c);
};

describe('B4: an ops:read key sees no buyer id and no agent key id', () => {
  it.each(VIEWS)('%s: the lines are there, the ids are not', async (view) => {
    const res = await viaKey(`?view=${view}`);
    expect(res.status).toBe(200);
    const lines = await items(res);
    expect(lines.map((l) => String(l['unit_id'])).sort()).toEqual([...VIEWS_MEMBERS[view]].sort());
    for (const l of lines) {
      expect(l).not.toHaveProperty('buyer_id');
      expect(l).not.toHaveProperty('agent_key_id');
    }
    await noCanary(res);
  });

  it('a plain call over every line carries neither id (deep scan)', async () => {
    const res = await viaKey('?limit=100');
    expect(res.status).toBe(200);
    expect((await items(res)).length).toBeGreaterThanOrEqual(11);
    await noCanary(res);
  });

  it('an operator session without MFA gets the same redaction', async () => {
    const res = await rig.old(sessionRoute, noMfa, {
      url: '/api/ops/transactions?view=agent_purchases',
    });
    expect(res.status).toBe(200);
    expect((await items(res)).length).toBe(VIEWS_EXPECTED.agent_purchases);
    await noCanary(res);
  });
});

describe('B4: the authorised path still sees both ids', () => {
  it('an operator session with MFA sees buyer_id and agent_key_id on agent purchases', async () => {
    const res = await rig.old(sessionRoute, mfa, {
      url: '/api/ops/transactions?view=agent_purchases',
    });
    expect(res.status).toBe(200);
    const lines = await items(res);
    expect(lines).toHaveLength(VIEWS_EXPECTED.agent_purchases);
    for (const l of lines) {
      expect(l['buyer_id']).toBe('vs_b2');
      expect(l['agent_key_id']).toBe('vs_key');
    }
  });
});

describe('B4 attacks (SR1 style): asking for the ids back', () => {
  it('asking for the fields or claiming MFA in the query adds nothing', async () => {
    for (const qs of [
      '?view=agent_purchases&fields=buyer_id,agent_key_id',
      '?view=agent_purchases&include=buyer_id&identity=1',
      '?view=agent_purchases&mfa=true',
    ]) {
      const res = await viaKey(qs);
      expect([200, 400]).toContain(res.status);
      await noCanary(res);
    }
  });

  it('claiming MFA in a header adds nothing', async () => {
    const res = await viaKey('?view=agent_purchases', {
      'x-ums-mfa': 'true',
      'x-mfa': '1',
      'x-operator-mfa': 'verified',
    });
    expect(res.status).toBe(200);
    await noCanary(res);
  });

  it('a bearer key plus an MFA session cookie is refused and leaks nothing', async () => {
    const res = await viaKey('?view=agent_purchases', { cookie: mfa.cookie });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await noCanary(res);
  });

  it('filtering by the buyer or by the key does not echo either id', async () => {
    for (const qs of ['?buyer=vs_b2&limit=100', '?agent_key=vs_key&limit=100']) {
      const res = await viaKey(qs);
      expect([200, 400]).toContain(res.status);
      if (res.status === 200)
        for (const l of await items(res)) {
          expect(l).not.toHaveProperty('buyer_id');
          expect(l).not.toHaveProperty('agent_key_id');
        }
    }
  });
});

describe('B4 attacks: other roles and tenants', () => {
  it("buyer, agent and seller keys, including the agent buyer's own, get 403", async () => {
    const vsB2: Actor = { kind: 'buyer', buyer_id: 'vs_b2' };
    const keys = [
      await rig.key(vsB2, ['orders:read']),
      await rig.key(rig.buyerA, ['orders:read']),
      await rig.key(rig.buyerA, ['orders:read'], 'agent'),
      await rig.key(rig.harbour, ['sales:read']),
    ];
    for (const k of keys) {
      const res = await rig.v1(keyRoute, k, { url: '/api/v1/ops/transactions?limit=100' });
      expect(res.status).toBe(403);
      await noCanary(res);
    }
  });
});
