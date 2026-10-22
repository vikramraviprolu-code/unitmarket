import { createHash } from 'node:crypto';
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

// Opus review 4: H2 (content swapped after the charge), M9 (link bound to the session), L7.
describe('delivery integrity and session binding (review 4)', () => {
  const swapBlob = async (n: number, body: string, alsoHash: boolean) => {
    const bytes = new TextEncoder().encode(body);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await w.db.query(
      alsoHash
        ? 'UPDATE content_blobs SET data = $2, bytes = $3, sha256 = $4 WHERE content_key = $1'
        : 'UPDATE content_blobs SET data = $2, bytes = $3 WHERE content_key = $1',
      alsoHash ? [`k${n}`, bytes, bytes.length, sha] : [`k${n}`, bytes, bytes.length],
    );
  };
  const kindsOf = async (id: string) =>
    (
      await w.db.query<{ kind: string }>(
        'SELECT kind FROM access_events WHERE entitlement_id = $1',
        [id],
      )
    ).rows.map((r) => r.kind);

  it('H2: a blob replaced after the charge (hash column rewritten too) is refused and recorded', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    await swapBlob(1, 'a different article that was never bought', true);
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    expect(plan).toEqual({ ok: false, error: { code: 'store_unavailable' } });
    const kinds = await kindsOf(it1.entitlement_id);
    expect(kinds).toContain('delivery_failed');
    expect(kinds).not.toContain('download_completed');
  });

  it('H2: bytes altered under an unchanged hash column are refused by the store', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    await swapBlob(1, 'altered bytes, old stored hash', false);
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    expect(plan.ok).toBe(false);
    expect(await kindsOf(it1.entitlement_id)).not.toContain('download_completed');
  });

  it('H2: the store refuses to open bytes that disagree with the stored hash column', async () => {
    const it1 = await w.deliverable(1);
    await swapBlob(1, 'altered bytes, old stored hash', false);
    const store = createPgContentStore(w.db);
    const head = await store.head('k1');
    expect(head?.sha256).not.toBe(it1.sha256);
    await expect(store.open('k1')).rejects.toThrow(/integrity/);
  });

  it('M9: a link issued for one session is not_found in another session', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), {
      entitlement_id: it1.entitlement_id,
      actor: buyer1,
      session_id: 'ses_a',
    });
    if (!issued.ok) throw new Error('issue failed');
    const token = tokenOf(issued.value.url);
    const other = await planServe(deps(), {
      token,
      actor: buyer1,
      mode: 'download',
      session_id: 'ses_b',
    });
    expect(other).toEqual({ ok: false, error: { code: 'not_found' } });
    const none = await planServe(deps(), { token, actor: buyer1, mode: 'download' });
    expect(none).toEqual({ ok: false, error: { code: 'not_found' } });
    const same = await planServe(deps(), {
      token,
      actor: buyer1,
      mode: 'download',
      session_id: 'ses_a',
    });
    expect(same.ok).toBe(true);
  });

  it('M9: a link issued without a session still works in any session of the buyer', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'read',
      session_id: 'ses_x',
    });
    expect(plan.ok).toBe(true);
  });

  it('L7: an unexpired token whose access window ended before serve time gets window_ended', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const endsAt = new Date(w.clock.now().getTime() + 60_000).toISOString();
    await w.db.query('UPDATE access_windows SET ends_at = $2 WHERE entitlement_id = $1', [
      it1.entitlement_id,
      endsAt,
    ]);
    w.clock.set(new Date(w.clock.now().getTime() + 120_000).toISOString() as never);
    expect(Date.parse(issued.value.expires_at)).toBeGreaterThan(w.clock.now().getTime());
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    expect(plan).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await kindsOf(it1.entitlement_id)).not.toContain('download_completed');
  });
});
