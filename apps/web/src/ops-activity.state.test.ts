// INT-TR1 / TR1.4: GET /api/ops/activity through the real route wrapper and the real app. Filters combine
// with AND; pages hold 50 (200 at most); a walk over 260+ rows with 20 new rows written between page calls
// skips and repeats nothing; a cursor made for another filter or principal gives 400 bad_cursor; the actor_id
// filter needs the second factor; an operator switch-off appears with mfa and channel web.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { TraceContext } from '@umsbx/contracts';
import { bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let rig: StartRig;
let route: typeof import('./app/api/ops/activity/route');
let mfa: Session;
let plain: Session;

const ctxOf = (id: string, over: Partial<TraceContext>): TraceContext => ({
  id,
  at: '2026-11-04T12:00:00.000Z',
  channel: 'job',
  actor_kind: 'system',
  actor_id: null,
  on_behalf_of: null,
  mandate_id: null,
  mfa: false,
  req_id: null,
  ip_hash: null,
  ua_family: null,
  api_key_id: null,
  job: 'probe',
  tool: null,
  ...over,
});
const alertAt = async (n: number, c: TraceContext, at: string): Promise<void> => {
  await withTraceContext(c, () =>
    rig.app.db.query(
      `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ($1, 'job_probe', jsonb_build_object('reason', $1::text), $2, $2)`,
      [`alr_act_${n}`, at],
    ),
  );
};
const at = (i: number): string =>
  new Date(Date.parse('2026-11-04T12:00:00Z') + i * 1000).toISOString();

beforeAll(async () => {
  rig = await bootStartRig();
  route = await import('./app/api/ops/activity/route');
  mfa = await rig.mfaOperator();
  plain = await rig.plainOperator();
  for (let i = 0; i < 130; i += 1) await alertAt(i, ctxOf(`ctx_act_job_${i}`, {}), at(i));
  for (let i = 130; i < 260; i += 1)
    await alertAt(
      i,
      ctxOf(`ctx_act_web_${i}`, {
        channel: 'web',
        actor_kind: 'operator',
        actor_id: 'vikram',
        mfa: true,
        job: null,
        req_id: `req_${i}`,
      }),
      at(i),
    );
});
afterAll(async () => {
  await rig?.app.close();
});

interface Item {
  at: string;
  seq: number;
  chain_key: string;
  event_type: string;
  actor: { kind: string };
  channel: string;
  mfa?: boolean;
  actor_id?: string;
  req_id?: string;
  source: { table: string; id: string };
}
interface Page {
  items: Item[];
  next_cursor: string | null;
}
const get = (s: Session | null, qs = '') =>
  call(route.GET, { url: `/api/ops/activity${qs}`, session: s });
const page = async (s: Session, qs = ''): Promise<Page> => {
  const r = await get(s, qs);
  expect(r.status).toBe(200);
  return (await r.json()) as Page;
};
const code = async (r: Response): Promise<string> =>
  ((await r.json()) as { error: { code: string } }).error.code;

describe('filters and page size', () => {
  it('needs an operator session', async () => {
    expect((await get(null)).status).toBe(401);
  });
  it('holds 50 by default and 200 at most', async () => {
    expect((await page(plain)).items.length).toBe(50);
    expect((await page(plain, '?limit=500')).items.length).toBe(200);
    expect((await page(plain, '?limit=10')).items.length).toBe(10);
  });
  it('newest first', async () => {
    const p = await page(plain, '?event_type=alerts.');
    const times = p.items.map((i) => i.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(p.items[0]!.source.id).toBe('alr_act_259');
  });
  it('combines filters with AND', async () => {
    const a = await page(plain, '?actor_kind=system&channel=job&event_type=alerts.&limit=200');
    expect(a.items.length).toBe(130);
    expect(a.items.every((i) => i.actor.kind === 'system' && i.channel === 'job')).toBe(true);
    const none = await page(plain, '?actor_kind=operator&channel=job&event_type=alerts.');
    expect(none.items).toEqual([]);
    const win = await page(mfa, `?event_type=alerts.&from=${at(100)}&to=${at(139)}&limit=200`);
    expect(win.items.length).toBe(40);
    const chain = await page(
      plain,
      `?chain_key=${encodeURIComponent('plat')}&event_type=alerts.&limit=200`,
    );
    expect(chain.items.length).toBe(200);
    expect(chain.next_cursor).not.toBeNull();
    expect((await page(plain, `?chain_key=${encodeURIComponent('ord:nope')}`)).items).toEqual([]);
  });
  it('refuses a filter value it does not know', async () => {
    expect((await get(plain, '?actor_kind=wizard')).status).toBe(422);
    expect((await get(plain, '?channel=carrier_pigeon')).status).toBe(422);
    expect((await get(plain, '?nope=1')).status).toBe(422);
  });
});

describe('identity', () => {
  it('without the second factor there is no actor id, no mfa flag and no request id', async () => {
    const p = await page(plain, '?actor_kind=operator&event_type=alerts.');
    for (const i of p.items) {
      expect(i).not.toHaveProperty('actor_id');
      expect(i).not.toHaveProperty('mfa');
      expect(i).not.toHaveProperty('req_id');
    }
    expect(JSON.stringify(p)).not.toContain('vikram');
  });
  it('the actor_id filter without MFA is 403 mfa_required; with MFA it works', async () => {
    const r = await get(plain, '?actor_id=vikram');
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('mfa_required');
    const p = await page(mfa, '?actor_id=vikram&event_type=alerts.&limit=200');
    expect(p.items.length).toBe(130);
    expect(p.items[0]!.actor_id).toBe('vikram');
    expect(p.items[0]!.mfa).toBe(true);
  });
  it('a switch-off by the operator appears with mfa and channel web', async () => {
    const res = await call(rig.stop.POST, {
      url: '/api/ops/stop',
      method: 'POST',
      session: mfa,
      body: { reason: 'activity test' },
    });
    expect(res.status).toBe(200);
    const p = await page(mfa, '?event_type=safety_switches.&actor_kind=operator');
    const row = p.items.find((i) => i.source.id === 'paypal_outbound');
    expect(row).toBeDefined();
    expect(row!.mfa).toBe(true);
    expect(row!.channel).toBe('web');
    expect(row!.actor_id).toBe('vikram');
  });
});

describe('paging while rows arrive', () => {
  it('skips and repeats nothing over 260 rows with 20 new rows between the page calls', async () => {
    const qs = '?event_type=alerts.&limit=50';
    const seen: string[] = [];
    let p = await page(mfa, qs);
    seen.push(...p.items.map((i) => `${i.chain_key}#${i.seq}`));
    for (let i = 0; i < 20; i += 1)
      await alertAt(1000 + i, ctxOf(`ctx_act_new_${i}`, {}), at(2000 + i));
    let guard = 0;
    while (p.next_cursor !== null && guard < 20) {
      guard += 1;
      p = await page(mfa, `${qs}&cursor=${encodeURIComponent(p.next_cursor)}`);
      seen.push(...p.items.map((i) => `${i.chain_key}#${i.seq}`));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(260);
  });
});

describe('cursors', () => {
  it('a cursor made for another filter or another principal gives 400 bad_cursor; so does a malformed one', async () => {
    const first = await page(mfa, '?event_type=alerts.&limit=10');
    const cur = encodeURIComponent(first.next_cursor!);
    expect((await get(mfa, `?event_type=alerts.&limit=10&cursor=${cur}`)).status).toBe(200);
    // The cursor is bound to the filters and the principal, not to the page size.
    expect((await get(mfa, `?event_type=alerts.&limit=20&cursor=${cur}`)).status).toBe(200);
    expect((await get(mfa, `?event_type=safety_switches.&limit=10&cursor=${cur}`)).status).toBe(
      400,
    );
    const other = await get(plain, `?event_type=alerts.&limit=10&cursor=${cur}`);
    expect(other.status).toBe(400);
    expect(await code(other)).toBe('bad_cursor');
    expect((await get(mfa, '?cursor=not-a-cursor')).status).toBe(400);
    const wrongTag = Buffer.from(
      JSON.stringify({ v: 'zz', k: ['2026-11-04T12:00:00.000Z', 'plat', 1], h: 'x' }),
    ).toString('base64url');
    const r = await get(mfa, `?cursor=${wrongTag}`);
    expect(r.status).toBe(400);
    expect(await code(r)).toBe('bad_cursor');
  });
});
