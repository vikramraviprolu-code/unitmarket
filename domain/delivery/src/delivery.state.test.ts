// eslint-disable-next-line no-restricted-imports -- hashing and HMAC are deterministic (no randomness); S1 bars node:* in domain packages (change request in the lane 09 hand-off)
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContentStore } from '@umsbx/contracts';
import {
  checkReadiness,
  createPgContentStore,
  issueLink,
  planServe,
  type ServePlan,
} from './index';
import { START, makeWorld, secretOf } from './world';
import type { World } from './world';

const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;
let w: World;
let flaky: { fail: boolean };
let store: ContentStore;
const deps = () => ({ ...w.deps, content: store });

beforeAll(async () => {
  w = await makeWorld('dlv');
  const pg = createPgContentStore(w.db);
  flaky = { fail: false };
  store = {
    head: (k) => (flaky.fail ? Promise.reject(new Error('store down')) : pg.head(k)),
    open: (k) => (flaky.fail ? Promise.reject(new Error('store down')) : pg.open(k)),
    health: () => (flaky.fail ? Promise.resolve(false) : pg.health()),
  };
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
  flaky.fail = false;
});

async function drain(p: ServePlan): Promise<{ bytes: Uint8Array; sha: string }> {
  const chunks: Uint8Array[] = [];
  for await (const c of p.body) chunks.push(c);
  const all = Buffer.concat(chunks);
  return { bytes: all, sha: createHash('sha256').update(all).digest('hex') };
}
const events = async (id: string) =>
  (
    await w.db.query<{ kind: string; link_id: string | null; evidence: Record<string, unknown> }>(
      'SELECT kind, link_id, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid',
      [id],
    )
  ).rows;
const tokenOf = (url: string) => url.replace(/^\/c\//, '');
const windowRow = async (id: string) =>
  (
    await w.db.query<{ state: string; ends_at: Date | null; paused_at: Date | null }>(
      'SELECT state, ends_at, paused_at FROM access_windows WHERE entitlement_id = $1',
      [id],
    )
  ).rows[0]!;

describe('delivery of an available item', () => {
  it('available item gets a link and bytes with matching sha256 and download_completed evidence', async () => {
    const it1 = await w.deliverable(1, { title: 'My Article' });
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.url).toMatch(/^\/c\/[A-Za-z0-9_-]+$/);
    expect(issued.value.expires_at).toBe(new Date(Date.parse(START) + 600_000).toISOString());

    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.status).toBe(200);
    expect(plan.value.headers['Content-Disposition']).toBe('attachment; filename="My Article.txt"');
    expect(plan.value.headers['Content-Type']).toBe('text/plain');
    const got = await drain(plan.value);
    expect(got.sha).toBe(it1.sha256);
    expect(Buffer.from(got.bytes).equals(Buffer.from(it1.body))).toBe(true);
    await plan.value.onFinish({ bytes: got.bytes.length, sha256: got.sha });

    const ev = await events(it1.entitlement_id);
    expect(ev.map((e) => e.kind)).toEqual(['access_ready', 'link_issued', 'download_completed']);
    const done = ev[2]!;
    expect(done.link_id).toBe(issued.value.link_id);
    expect(done.evidence).toMatchObject({ bytes: it1.body.length, sha256: it1.sha256 });
  });

  it('read mode is inline and records reader_rendered', async () => {
    const it1 = await w.deliverable(1, { mime: 'text/markdown' });
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'read',
    });
    if (!plan.ok) throw new Error('plan failed');
    expect(plan.value.headers['Content-Disposition']).toMatch(/^inline; filename="/);
    const got = await drain(plan.value);
    await plan.value.onFinish({ bytes: got.bytes.length, sha256: got.sha });
    expect((await events(it1.entitlement_id)).map((e) => e.kind)).toContain('reader_rendered');
  });

  it('onFinish with a different sha256 records delivery_failed and not download_completed', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    if (!plan.ok) throw new Error('plan failed');
    await plan.value.onFinish({ bytes: 5, sha256: 'b'.repeat(64) });
    const kinds = (await events(it1.entitlement_id)).map((e) => e.kind);
    expect(kinds).toContain('delivery_failed');
    expect(kinds).not.toContain('download_completed');
  });

  it('aborted stream records download_aborted', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    if (!plan.ok) throw new Error('plan failed');
    await plan.value.onAbort(7);
    const ev = await events(it1.entitlement_id);
    const aborted = ev.find((e) => e.kind === 'download_aborted');
    expect(aborted?.evidence).toMatchObject({ sent_bytes: 7 });
    expect(ev.map((e) => e.kind)).not.toContain('download_completed');
    expect((await windowRow(it1.entitlement_id)).state).toBe('running');
  });

  it('store failure records delivery_failed and pauses the window (A-18)', async () => {
    const it1 = await w.deliverable(1);
    w.clock.advance(60 * 60 * 1000);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    flaky.fail = true;
    const plan = await planServe(deps(), {
      token: tokenOf(issued.value.url),
      actor: buyer1,
      mode: 'download',
    });
    expect(plan).toEqual({ ok: false, error: { code: 'store_unavailable' } });
    expect((await events(it1.entitlement_id)).map((e) => e.kind)).toContain('delivery_failed');
    const paused = await windowRow(it1.entitlement_id);
    expect(paused.state).toBe('paused');

    // The next successful delivery resumes the window and adds the lost time (rounded up to the hour).
    flaky.fail = false;
    w.clock.advance(3 * 60 * 60 * 1000);
    const again = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!again.ok) throw new Error('reissue failed');
    const plan2 = await planServe(deps(), {
      token: tokenOf(again.value.url),
      actor: buyer1,
      mode: 'download',
    });
    if (!plan2.ok) throw new Error('plan2 failed');
    const got = await drain(plan2.value);
    await plan2.value.onFinish({ bytes: got.bytes.length, sha256: got.sha });
    const resumed = await windowRow(it1.entitlement_id);
    expect(resumed.state).toBe('running');
    expect(resumed.ends_at!.toISOString()).toBe(
      new Date(Date.parse(START) + 432_000_000 + 3 * 3_600_000).toISOString(),
    );
  });

  it('a store error while streaming records delivery_failed', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    const broken: ContentStore = {
      ...store,
      open: () =>
        Promise.resolve({
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            throw new Error('disk gone');
          },
        }),
    };
    const plan = await planServe(
      { ...w.deps, content: broken },
      { token: tokenOf(issued.value.url), actor: buyer1, mode: 'download' },
    );
    if (!plan.ok) throw new Error('plan failed');
    await expect(drain(plan.value)).rejects.toThrow('disk gone');
    expect((await events(it1.entitlement_id)).map((e) => e.kind)).toContain('delivery_failed');
  });

  it('link re-issue keeps ends_at and writes no order or ledger row', async () => {
    const it1 = await w.deliverable(1);
    const count = async (t: string) =>
      Number((await w.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);
    const before = { orders: await count('orders'), ledger: await count('ledger_entries') };
    const first = await windowRow(it1.entitlement_id);
    const a = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    w.clock.advance(4 * 24 * 3_600_000);
    const b = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.link_id).not.toBe(a.value.link_id);
    expect((await windowRow(it1.entitlement_id)).ends_at!.toISOString()).toBe(
      first.ends_at!.toISOString(),
    );
    expect(await count('orders')).toBe(before.orders);
    expect(await count('ledger_entries')).toBe(before.ledger);
    expect((await events(it1.entitlement_id)).filter((e) => e.kind === 'link_issued')).toHaveLength(
      2,
    );
  });

  it('an expired token and an ended window are refused', async () => {
    const it1 = await w.deliverable(1);
    const issued = await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 });
    if (!issued.ok) throw new Error('issue failed');
    w.clock.advance(601_000);
    expect(
      await planServe(deps(), {
        token: tokenOf(issued.value.url),
        actor: buyer1,
        mode: 'download',
      }),
    ).toEqual({ ok: false, error: { code: 'expired' } });
    expect(await planServe(deps(), { token: 'garbage', actor: buyer1, mode: 'download' })).toEqual({
      ok: false,
      error: { code: 'bad_token' },
    });
    w.clock.advance(5 * 24 * 3_600_000);
    expect(await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 })).toEqual({
      ok: false,
      error: { code: 'window_ended' },
    });
  });

  it('issuing a link refuses when the store cannot supply the object', async () => {
    const it1 = await w.deliverable(1);
    flaky.fail = true;
    expect(await issueLink(deps(), { entitlement_id: it1.entitlement_id, actor: buyer1 })).toEqual({
      ok: false,
      error: { code: 'store_unavailable' },
    });
  });
});

describe('readiness before capture', () => {
  it('readiness: missing object, hash mismatch, signer failure each refused (A-17)', async () => {
    const it1 = await w.deliverable(1, { ready: false });
    const ok = await checkReadiness(deps(), {
      article_id: it1.article_id,
      expected_sha256: it1.sha256,
    });
    expect(ok).toEqual({ ok: true, value: { link_probe: 'ok', content_sha256: it1.sha256 } });

    await w.db.query("UPDATE articles SET content_key = 'nowhere' WHERE id = $1", [it1.article_id]);
    expect(
      await checkReadiness(deps(), { article_id: it1.article_id, expected_sha256: it1.sha256 }),
    ).toEqual({ ok: false, error: { code: 'missing' } });
    expect(
      await checkReadiness(deps(), { article_id: 'art_unknown', expected_sha256: it1.sha256 }),
    ).toEqual({ ok: false, error: { code: 'missing' } });
    await w.db.query("UPDATE articles SET content_key = 'k1' WHERE id = $1", [it1.article_id]);

    expect(
      await checkReadiness(deps(), { article_id: it1.article_id, expected_sha256: 'c'.repeat(64) }),
    ).toEqual({ ok: false, error: { code: 'hash_mismatch' } });

    // Stored bytes altered behind the recorded hash: head recomputes, so the probe sees it.
    await w.db.query("UPDATE content_blobs SET data = '\\x00ff'::bytea WHERE content_key = 'k1'");
    expect(
      await checkReadiness(deps(), { article_id: it1.article_id, expected_sha256: it1.sha256 }),
    ).toEqual({ ok: false, error: { code: 'hash_mismatch' } });

    const sealed = secretOf('');
    expect(
      await checkReadiness(
        { ...deps(), config: { ...w.deps.config, link_secret: sealed } },
        { article_id: it1.article_id, expected_sha256: it1.sha256 },
      ),
    ).toEqual({ ok: false, error: { code: 'hash_mismatch' } });
  });

  it('signer failure is refused after the object checks pass', async () => {
    const it1 = await w.deliverable(1, { ready: false });
    const noSecret = secretOf('');
    expect(
      await checkReadiness(
        { ...deps(), config: { ...w.deps.config, link_secret: noSecret } },
        { article_id: it1.article_id, expected_sha256: it1.sha256 },
      ),
    ).toEqual({ ok: false, error: { code: 'signer_failed' } });
    flaky.fail = true;
    expect(
      await checkReadiness(deps(), { article_id: it1.article_id, expected_sha256: it1.sha256 }),
    ).toEqual({ ok: false, error: { code: 'store_unavailable' } });
  });
});

describe('pg content store', () => {
  it('head reports the recomputed sha256 and open streams the bytes', async () => {
    const it1 = await w.deliverable(1, { ready: false });
    const s = createPgContentStore(w.db);
    expect(await s.head('k1')).toEqual({
      bytes: it1.body.length,
      sha256: it1.sha256,
      mime: 'text/plain',
    });
    expect(await s.head('nope')).toBeNull();
    expect(await s.open('nope')).toBeNull();
    const chunks: Uint8Array[] = [];
    for await (const c of (await s.open('k1'))!) chunks.push(c);
    expect(Buffer.concat(chunks).equals(Buffer.from(it1.body))).toBe(true);
    expect(await s.health()).toBe(true);
  });
});
