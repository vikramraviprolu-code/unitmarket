import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgContentStore, issueLink, planServe } from './index';
import { makeWorld } from './world';
import type { World } from './world';

const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;
const buyer2 = { kind: 'buyer', buyer_id: 'buy_2' } as const;
let w: World;
const deps = () => ({ ...w.deps, content: createPgContentStore(w.db) });
const tokenOf = (url: string) => url.replace(/^\/c\//, '');

beforeAll(async () => {
  w = await makeWorld('adv');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
});

describe('delivery access control', () => {
  it("buyer B with buyer A's token gets not_found (P13, A-20)", async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const token = tokenOf(issued.value.url);
    const stolen = await planServe(deps(), { token, actor: buyer2, mode: 'download' });
    expect(stolen).toEqual({ ok: false, error: { code: 'not_found' } });
    for (const actor of [
      { kind: 'system' },
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'operator', operator_id: 'op_1', mfa: true },
    ] as const) {
      expect(await planServe(deps(), { token, actor, mode: 'download' })).toEqual({
        ok: false,
        error: { code: 'not_found' },
      });
    }
    // Buyer B cannot mint a link for A's item either, and the answer equals an unknown id.
    const mint = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer2 });
    const unknown = await issueLink(deps(), { entitlement_id: 'ent_unknown', actor: buyer2 });
    expect(mint).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(unknown).toEqual(mint);
    const none = await w.db.query('SELECT 1 FROM access_events WHERE kind = $1 AND source = $2', [
      'download_completed',
      'system',
    ]);
    expect(none.rows).toHaveLength(0);
  });

  it('revoked own item gets not_available', async () => {
    const it1 = await w.deliverable(1, { ready: false });
    await w.db.query(
      "UPDATE entitlements SET money_state = 'refunded', access_state = 'revoked', licence_state = 'terminated' WHERE id = $1",
      [it1.entitlement_id],
    );
    expect(await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 })).toEqual({
      ok: false,
      error: { code: 'not_available', access: 'revoked', money: 'refunded' },
    });
  });

  it('a link issued before revocation stops working once the item is revoked', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    await w.db.query(
      "UPDATE entitlements SET money_state = 'refunded', access_state = 'revoked', licence_state = 'terminated' WHERE id = $1",
      [it1.entitlement_id],
    );
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    expect(plan).toEqual({
      ok: false,
      error: { code: 'not_available', access: 'revoked', money: 'refunded' },
    });
  });

  it('every response carries no-store and no-referrer (P14)', async () => {
    for (const [n, mode, mime] of [
      [1, 'download', 'text/plain'],
      [2, 'read', 'text/html'],
      [3, 'download', 'application/pdf'],
    ] as const) {
      const it1 = await w.deliverable(n, { mime });
      const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
      if (!issued.ok) throw new Error('issue failed');
      const plan = await planServe(deps(), {
        token: tokenOf(issued.value.url),
        actor: buyer1,
        mode,
      });
      if (!plan.ok) throw new Error('plan failed');
      expect(plan.value.headers['Cache-Control']).toBe('private, no-store');
      expect(plan.value.headers['Referrer-Policy']).toBe('no-referrer');
      expect(plan.value.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(plan.value.headers['Content-Type']).toBe(mime);
      expect(plan.value.headers['Content-Security-Policy']).toContain('sandbox');
    }
  });

  it('the link row stores a hash of the token, never the token', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const rows = await w.db.query<{ token_hash: string }>('SELECT token_hash FROM links');
    expect(rows.rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows.rows)).not.toContain(tokenOf(issued.value.url));
  });

  it('no upload path exists (SOP 16)', async () => {
    const api = await import('./index');
    expect(Object.keys(api).filter((k) => /upload|put|write|save/i.test(k))).toEqual([]);
  });
});
