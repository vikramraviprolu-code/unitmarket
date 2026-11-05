// INT-OPS-B / OPS-B.4: Controls > Activity. The page is a server shell that mounts a client table; the table
// reads GET /api/ops/activity (TR1) through getJson. lib/activity-view.ts holds the logic and is tested against
// that route's own answers: an MFA session sees who switched what off, with mfa, the channel and the time; a
// session without MFA gets identity-free rows and is never offered the actor_id filter; filters narrow; the
// switch history preset lists switch events only; the next page link carries TR1's cursor unchanged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { TraceContext } from '@umsbx/contracts';
import { NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call } from './support';
import type { Session } from './support';
import { ACTIVITY_PRESETS, offeredFields, parseQueryString } from './lib/filter-bar-view';
import {
  ACTIVITY_PATH,
  activityPageView,
  activityRowsOf,
  activityUrl,
  nextPageHref,
} from './lib/activity-view';
import type { ActivityItem } from './lib/activity-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

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
const at = (i: number): string =>
  new Date(Date.parse('2026-11-04T12:00:00Z') + i * 1000).toISOString();
const alertAt = async (n: number, c: TraceContext, when: string): Promise<void> => {
  await withTraceContext(c, () =>
    rig.app.db.query(
      `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ($1::text, 'job_probe', jsonb_build_object('reason', $1::text), $2, $2)`,
      [`alr_av_${n}`, when],
    ),
  );
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rig = await bootStartRig();
  route = await import('./app/api/ops/activity/route');
  mfa = await rig.mfaOperator();
  plain = await rig.plainOperator();
  for (let i = 0; i < 60; i += 1) await alertAt(i, ctxOf(`ctx_av_job_${i}`, {}), at(i));
  for (let i = 60; i < 70; i += 1)
    await alertAt(
      i,
      ctxOf(`ctx_av_web_${i}`, {
        channel: 'web',
        actor_kind: 'operator',
        actor_id: 'opr_vikram',
        mfa: true,
        job: null,
        req_id: `req_av_${i}`,
      }),
      at(i),
    );
  const off = await call(rig.stop.POST, {
    url: '/api/ops/stop',
    method: 'POST',
    session: mfa,
    body: { reason: 'activity view test' },
  });
  expect(off.status).toBe(200);
});
afterAll(async () => {
  await rig?.app.close();
});

type Page = { items: ActivityItem[]; next_cursor: string | null };
const MFA_CTX = { kind: 'activity', mfa: true } as const;
const PLAIN_CTX = { kind: 'activity', mfa: false } as const;
const read = async (s: Session, url: string): Promise<Page> => {
  const res = await call(route.GET, { url, session: s });
  expect(res.status, url).toBe(200);
  return (await res.json()) as Page;
};

describe('OPS-B.4 who switched what off', () => {
  it('on an MFA session a switch turned off shows the operator, mfa, channel web and the time', async () => {
    const preset = ACTIVITY_PRESETS.find((p) => p.id === 'switch_history')!;
    const page = await read(mfa, activityUrl(MFA_CTX, preset.map));
    const rows = activityRowsOf(page.items, { mfa: true });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => r.source_id === 'paypal_outbound');
    expect(row).toBeDefined();
    expect(row!.actor_id).toBe('opr_vikram');
    expect(row!.mfa).toBe(true);
    expect(row!.mfa_word).toBe('With the second factor');
    expect(row!.channel).toBe('web');
    expect(row!.channel_word).toBe('Website');
    expect(row!.actor_word).toBe('Operator');
    expect(row!.when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(row!.event).toMatch(/safety switches/i);
  });

  it('the switch history preset lists only switch events', async () => {
    const preset = ACTIVITY_PRESETS.find((p) => p.id === 'switch_history')!;
    const url = activityUrl(MFA_CTX, preset.map);
    expect(url).toBe(`${ACTIVITY_PATH}?event_type=safety_switches.`);
    const rows = activityRowsOf((await read(mfa, url)).items, { mfa: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.event_type.startsWith('safety_switches.')).toBe(true);
  });
});

describe('OPS-B.4 without the second factor (B5)', () => {
  it('the rows are identity free and actor_id is not offered, so the page never triggers the 403', async () => {
    expect(offeredFields(PLAIN_CTX)).not.toContain('actor_id');
    // Even a URL that asks for it is cleaned before it is sent: the answer is a 200, not mfa_required.
    const url = activityUrl(PLAIN_CTX, parseQueryString('actor_id=opr_vikram&event_type=alerts.'));
    expect(url).toBe(`${ACTIVITY_PATH}?event_type=alerts.`);
    const page = await read(plain, url);
    const rows = activityRowsOf(page.items, { mfa: false });
    expect(rows.length).toBe(50);
    for (const r of rows) {
      expect(r.mfa).toBeNull();
      expect(r.mfa_word).toBeNull();
      expect(r.req_id).toBeNull();
    }
    const text = JSON.stringify(rows);
    expect(text).not.toContain('req_av_');
    expect(text).not.toContain('ip_hash');
  });

  it('shows the operator id only where TR1 sent it (system and operator rows), never for others', async () => {
    const page = await read(plain, activityUrl(PLAIN_CTX, parseQueryString('event_type=alerts.&limit=100')));
    const rows = activityRowsOf(page.items, { mfa: false });
    for (const r of rows) if (r.actor_id !== null) expect(['system', 'operator']).toContain(r.actor_kind);
  });

  it('a server refusal is worded, not shown raw', () => {
    const v = activityPageView(
      { ok: false, status: 403, code: 'mfa_required', message: 'Filtering by actor needs the second factor.' },
      { mfa: false },
    );
    expect(v).toEqual({ kind: 'error', message: expect.stringMatching(/second factor|authenticator/i) });
    const bad = activityPageView({ ok: false, status: 400, code: 'bad_cursor', message: 'x' }, { mfa: true });
    expect(bad).toEqual({ kind: 'error', message: expect.stringMatching(/first page/i) });
  });
});

describe('OPS-B.4 filters and paging', () => {
  it('filters narrow: channel, actor kind and the event prefix combine with AND', async () => {
    const all = await read(mfa, activityUrl(MFA_CTX, parseQueryString('event_type=alerts.&limit=200')));
    const web = await read(mfa, activityUrl(MFA_CTX, parseQueryString('event_type=alerts.&channel=web&limit=200')));
    const job = await read(
      mfa,
      activityUrl(MFA_CTX, parseQueryString('event_type=alerts.&actor_kind=system&channel=job&limit=200')),
    );
    expect(all.items.length).toBe(70);
    expect(web.items.length).toBe(10);
    expect(job.items.length).toBe(60);
    const none = await read(
      mfa,
      activityUrl(MFA_CTX, parseQueryString('event_type=alerts.&actor_kind=operator&channel=job')),
    );
    expect(activityPageView({ ok: true, data: none }, { mfa: true }).kind).toBe('empty');
    const named = await read(mfa, activityUrl(MFA_CTX, parseQueryString('actor_id=opr_vikram&event_type=alerts.&limit=200')));
    expect(named.items.length).toBe(10);
  });

  it('the next page link carries the cursor TR1 gave, unchanged, with the filters', async () => {
    const raw = parseQueryString('event_type=alerts.');
    const first = await read(mfa, activityUrl(MFA_CTX, raw));
    expect(first.items.length).toBe(50);
    expect(first.next_cursor).not.toBeNull();
    const href = nextPageHref('/ops/controls/activity', MFA_CTX, raw, first.next_cursor);
    expect(href).not.toBeNull();
    const query = href!.split('?')[1]!;
    const back = parseQueryString(query);
    expect(back['cursor']).toBe(first.next_cursor);
    expect(back['event_type']).toBe('alerts.');
    // Following it: the table sends the same cursor, and TR1 answers the rest.
    const second = await read(mfa, activityUrl(MFA_CTX, back, back['cursor']));
    expect(second.items.length).toBe(20);
    expect(second.next_cursor).toBeNull();
    const keys = new Set([...first.items, ...second.items].map((i) => `${i.chain_key}#${i.seq}`));
    expect(keys.size).toBe(70);
    expect(nextPageHref('/ops/controls/activity', MFA_CTX, raw, null)).toBeNull();
  });

  it('a new filter starts again at the first page: the bar leaves the cursor behind', () => {
    const url = activityUrl(MFA_CTX, parseQueryString('channel=web&cursor=oldcursor'));
    expect(url).toBe(`${ACTIVITY_PATH}?channel=web`);
  });
});

describe('OPS-B.4 the page reads only through getJson', () => {
  it('the table, the view and the page hold no fetch( of their own', () => {
    for (const f of [
      'ui/ops/ActivityTable.tsx',
      'lib/activity-view.ts',
      'app/ops/controls/activity/page.tsx',
    ])
      expect(source(f), f).not.toMatch(/\bfetch\s*\(/);
    expect(source('ui/ops/ActivityTable.tsx')).toMatch(/getJson/);
  });

  it('the page checks for an operator first and reads only from the Controls module', () => {
    const page = source('app/ops/controls/activity/page.tsx');
    expect(page).toMatch(/if \(actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/controls\/activity'\);/);
    expect(page).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/composition\/ops-controls'/);
    expect(page).not.toMatch(/composition\.server|server\/access/);
  });
});
