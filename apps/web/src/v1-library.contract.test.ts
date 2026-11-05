// INT-SR1 (SR1.6): GET /api/v1/library takes paging and four filters: purchased date (from, to), seller
// (name, slug or id), item text (q) and access state (available, ended, revoked). A call with no parameters
// is unchanged: every entry, next_cursor null. Any filter, limit or cursor pages (default 25, max 100).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LibraryListSchema } from '@umsbx/contracts';
import { HARBOUR_FERRY, QUAY_WALK, runPack } from './composite-support';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json } from './search-support';
import type { Handler, SearchRig } from './search-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

interface Entry {
  entitlement_id: string;
  title: string;
  publisher: string;
  access: string;
}
interface Page {
  items: Entry[];
  next_cursor: string | null;
}

let rig: SearchRig;
let token: string;
let route: Handler;
let all: Entry[];

const get = async (qs: string, t = token) => {
  const res = await rig.v1(route, t, { url: `/api/v1/library${qs}` });
  return { res, body: await json<Page>(res) };
};

beforeAll(async () => {
  rig = await bootSearch();
  token = await rig.key(rig.buyerA, ['library:read']);
  route = (await import('./app/api/v1/library/route')).GET as Handler;
  expect((await runPack(rig.app, rig.buyerA, [HARBOUR_FERRY], ['happy'])).returns[0]!.ok).toBe(
    true,
  );
  expect((await runPack(rig.app, rig.buyerA, [QUAY_WALK], ['happy'])).returns[0]!.ok).toBe(true);
  all = LibraryListSchema.parse(
    await rig.app.engine
      .library({ actor: rig.buyerA })
      .then((items) => ({ items, next_cursor: null })),
  ).items;
  expect(all.length).toBe(2);
});

const quay = () => all.find((e) => e.publisher.toLowerCase().includes('quay'))!;
const harbour = () => all.find((e) => e.publisher.toLowerCase().includes('harbour'))!;

describe('SR1.6 library', () => {
  it('no parameters: unchanged', async () => {
    const { res, body } = await get('');
    expect(res.status).toBe(200);
    LibraryListSchema.parse(body);
    expect(body.items).toEqual(JSON.parse(JSON.stringify(all)));
    expect(body.next_cursor).toBeNull();
  });

  it('item text narrows', async () => {
    const t = harbour().title.split(' ')[0]!;
    const { body } = await get(`?q=${encodeURIComponent(t.toLowerCase())}`);
    expect(body.items.map((e) => e.entitlement_id)).toContain(harbour().entitlement_id);
    expect((await get('?q=zzzz-no-such-title')).body.items).toEqual([]);
    expect((await get('?q=%25')).body.items).toEqual([]);
  });

  it('seller narrows by name or slug', async () => {
    const byName = await get('?seller=quayside');
    expect(byName.body.items.map((e) => e.entitlement_id)).toEqual([quay().entitlement_id]);
    const bySlug = await get('?seller=harbour-ledger');
    expect(bySlug.body.items.map((e) => e.entitlement_id)).toEqual([harbour().entitlement_id]);
    expect((await get('?seller=nobody')).body.items).toEqual([]);
  });

  it('purchased date narrows (from, to)', async () => {
    await rig.app.db.query(
      `UPDATE entitlements SET created_at = '2026-01-10T10:00:00.000Z' WHERE id = $1`,
      [quay().entitlement_id],
    );
    expect(
      (await get('?from=2026-01-10&to=2026-01-10')).body.items.map((e) => e.entitlement_id),
    ).toEqual([quay().entitlement_id]);
    expect((await get('?to=2026-01-09')).body.items).toEqual([]);
    const recent = await get('?from=2026-02-01');
    expect(recent.body.items.map((e) => e.entitlement_id)).toEqual([harbour().entitlement_id]);
  });

  it('access state narrows (available, ended, revoked)', async () => {
    expect((await get('?access=available')).body.items.length).toBeGreaterThanOrEqual(1);
    await rig.app.db.query(
      `UPDATE entitlements SET access_state = 'revoked', money_state = 'refunded' WHERE id = $1`,
      [quay().entitlement_id],
    );
    expect((await get('?access=revoked')).body.items.map((e) => e.entitlement_id)).toEqual([
      quay().entitlement_id,
    ]);
    expect((await get('?access=ended')).body.items).toEqual([]);
    expect((await get('?access=available')).body.items.map((e) => e.entitlement_id)).toEqual([
      harbour().entitlement_id,
    ]);
    expect((await get('?access=bogus')).body.items).toHaveLength(2);
  });

  it('pages: limit 1 gives one entry and a cursor, the next page the other', async () => {
    const p1 = await get('?limit=1');
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.next_cursor).not.toBeNull();
    const p2 = await get(`?limit=1&cursor=${p1.body.next_cursor!}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.next_cursor).toBeNull();
    expect(p2.body.items[0]!.entitlement_id).not.toBe(p1.body.items[0]!.entitlement_id);
  });

  it('a cursor of another filter or another buyer is bad_cursor; garbage too', async () => {
    const p1 = await get('?limit=1');
    expect((await get(`?limit=1&seller=harbour&cursor=${p1.body.next_cursor!}`)).res.status).toBe(
      400,
    );
    const other = await rig.key(rig.buyerB, ['library:read']);
    const res = await get(`?limit=1&cursor=${p1.body.next_cursor!}`, other);
    expect(res.res.status).toBe(400);
    expect((await get('?cursor=garbage')).res.status).toBe(400);
  });

  it('another buyer sees none of these entries', async () => {
    const other = await rig.key(rig.buyerB, ['library:read']);
    expect((await get('?q=a', other)).body.items).toEqual([]);
  });
});
