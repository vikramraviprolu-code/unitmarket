// INT-OPS-A / OPS-A.3: the alert list and the alert detail of the operator. The list filters by state, severity
// and kind exactly as AL.1 does and shows AL's true total, with a "show resolved" toggle. The detail shows the
// cause, the money at risk, the case link and the one fix link of the catalogue, and offers acknowledge,
// resolve (with a reason code from the closed list) and reopen, which post to AL's /api/ops/alerts/[id]/*
// routes. Every read goes through composition/ops-home.ts (S3).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPS_PAGES, RESOLVE_REASON_CODES } from '@umsbx/contracts';
import { formatMinor } from './lib/format';
import { safeNext } from './lib/next-path';
import {
  RESOLVE_REASON_WORDS,
  alertDetailView,
  alertListView,
  alertQuery,
  alertsHref,
  fixHref,
  moneyText,
  orderAnchor,
  orderHref,
  parseAlertFilter,
} from './lib/ops-alerts-view';
import { bootAlertRig, key, post, seedAlert } from './ops-alerts-support';
import type { AlertRig } from './ops-alerts-support';

vi.mock('server-only', () => ({}));

let rig: AlertRig;
let home: typeof import('./composition/ops-home');
type Handler = Parameters<typeof post>[0];
const route = async (verb: 'acknowledge' | 'resolve' | 'reopen'): Promise<Handler> =>
  (verb === 'acknowledge'
    ? await import('./app/api/ops/alerts/[id]/acknowledge/route')
    : verb === 'resolve'
      ? await import('./app/api/ops/alerts/[id]/resolve/route')
      : await import('./app/api/ops/alerts/[id]/reopen/route')
  ).POST as Handler;
const go = async (verb: 'acknowledge' | 'resolve' | 'reopen', id: string, body: unknown = {}) =>
  post(await route(verb), `/api/ops/alerts/${id}/${verb}`, {
    session: rig.op,
    body,
    params: { id },
  });

beforeAll(async () => {
  rig = await bootAlertRig();
  home = await import('./composition/ops-home');
  // 2 critical, 3 high, 2 medium, 1 info: eight alerts, then one acknowledged and one resolved.
  const kinds: [string, string][] = [
    ['alr_v01', 'frozen_order'],
    ['alr_v02', 'reversal'],
    ['alr_v03', 'payment_unresolved'],
    ['alr_v04', 'payment_unresolved'],
    ['alr_v05', 'unexpected_capture'],
    ['alr_v06', 'create_rejected'],
    ['alr_v07', 'content_unavailable'],
    ['alr_v08', 'reversal_hint'],
  ];
  for (const [id, kind] of kinds) await seedAlert(rig.rig, { id, kind, reason: id });
  await go('acknowledge', 'alr_v03');
  await go('resolve', 'alr_v06', { reason_code: 'false_positive' });
});
afterAll(async () => rig?.rig.app.close());

const listFor = async (sp: Record<string, string>) => {
  const f = parseAlertFilter(sp);
  const list = await home.readAlertList(alertQuery(f));
  return { f, list, view: alertListView(list, f) };
};

describe('the filters', () => {
  it('default to the alerts that still wait, and read bad input as the default', () => {
    expect(parseAlertFilter({})).toEqual({ state: 'open' });
    expect(parseAlertFilter({ state: 'nonsense', severity: 'huge', kind: '' })).toEqual({
      state: 'open',
    });
    expect(parseAlertFilter({ state: ['resolved', 'open'] })).toEqual({ state: 'resolved' });
    expect(
      parseAlertFilter({ state: 'all', severity: 'high', kind: 'payment_unresolved' }),
    ).toEqual({ state: 'all', severity: 'high', kind: 'payment_unresolved' });
  });

  it('build an address and read it back', () => {
    expect(alertsHref({ state: 'open' })).toBe('/ops/alerts');
    expect(alertsHref({ state: 'all', severity: 'high' })).toBe(
      '/ops/alerts?state=all&severity=high',
    );
    const f = { state: 'acknowledged', severity: 'high', kind: 'payment_unresolved' } as const;
    const q = Object.fromEntries(new URL(alertsHref(f), 'http://x').searchParams);
    expect(parseAlertFilter(q)).toEqual(f);
  });

  it('give AL totals, by state', async () => {
    expect((await listFor({})).view.total).toBe(6); // open: 8 seeded, minus acknowledged and resolved
    expect((await listFor({ state: 'acknowledged' })).view.total).toBe(1);
    expect((await listFor({ state: 'resolved' })).view.total).toBe(1);
    expect((await listFor({ state: 'all' })).view.total).toBe(8);
  });

  it('give AL totals, by severity and by kind, and they combine', async () => {
    expect((await listFor({ state: 'all', severity: 'critical' })).view.total).toBe(2);
    expect((await listFor({ state: 'all', severity: 'high' })).view.total).toBe(3);
    expect((await listFor({ state: 'all', severity: 'medium' })).view.total).toBe(2);
    expect((await listFor({ state: 'all', severity: 'info' })).view.total).toBe(1);
    expect((await listFor({ state: 'all', kind: 'payment_unresolved' })).view.total).toBe(2);
    expect((await listFor({ kind: 'payment_unresolved' })).view.total).toBe(1);
    expect(
      (await listFor({ state: 'all', severity: 'high', kind: 'frozen_order' })).view.total,
    ).toBe(0);
  });

  it('equal the engine answer for every combination, and a row is never lost to a page', async () => {
    for (const state of ['open', 'acknowledged', 'resolved', 'all']) {
      for (const severity of [undefined, 'critical', 'high', 'medium', 'info']) {
        const sp = { state, ...(severity === undefined ? {} : { severity }) };
        const { f, view } = await listFor(sp);
        const direct = await rig.rig.app.engine.opsReads.alerts(alertQuery(f));
        expect(view.total).toBe(direct.total);
        expect(view.rows.map((r) => r.id)).toEqual(direct.items.map((i) => i.id));
      }
    }
  });

  it('true totals: a list longer than one page says so, and the next link keeps the filter', async () => {
    for (let i = 0; i < 30; i += 1)
      await seedAlert(rig.rig, {
        id: `alr_w${String(i).padStart(2, '0')}`,
        kind: 'reversal_hint',
        reason: `w${i}`,
      });
    const { list, view } = await listFor({ state: 'all', severity: 'info' });
    expect(list.total).toBe(31);
    expect(view.total).toBe(31);
    expect(view.rows.length).toBe(25);
    expect(view.total_text).toBe('31 alerts');
    expect(view.next_href).toContain('severity=info');
    expect(view.next_href).toContain('cursor=');
  });

  it('say 1 alert, not 1 alerts, and none when none', async () => {
    expect((await listFor({ state: 'acknowledged' })).view.total_text).toBe('1 alert');
    const empty = alertListView({ items: [], total: 0, next_cursor: null }, { state: 'open' });
    expect(empty.total_text).toBe('No alerts');
    expect(empty.rows).toEqual([]);
  });

  it('the show resolved toggle adds resolved alerts and the same link takes them away', async () => {
    const open = (await listFor({})).view.show_resolved;
    expect(open).toEqual({ on: false, href: '/ops/alerts?state=all' });
    const all = (await listFor({ state: 'all' })).view.show_resolved;
    expect(all).toEqual({ on: true, href: '/ops/alerts' });
    const sev = (await listFor({ severity: 'high' })).view.show_resolved;
    expect(sev.href).toBe('/ops/alerts?state=all&severity=high');
  });

  it('every row names the alert, links to its page, and carries a fix link inside the shell', async () => {
    const { view } = await listFor({ state: 'all', severity: 'critical' });
    const pages: readonly string[] = OPS_PAGES;
    expect(view.rows.length).toBe(2);
    for (const r of view.rows) {
      expect(r.href).toBe(`/ops/alerts/${r.id}`);
      expect(r.title.length).toBeGreaterThan(3);
      expect(pages).toContain(r.fix_href.split('#')[0]);
    }
  });
});

describe('the alert detail', () => {
  const view = async (id: string, mfa = true) => {
    const d = await home.readAlertDetail(id);
    expect(d).not.toBeNull();
    return alertDetailView(d!, {
      mfa,
      keys: { acknowledge: 'k1', resolve: 'k2', reopen: 'k3' },
      order_anchor: null,
    });
  };

  it('shows cause, title, state and the fix link of the catalogue', async () => {
    const d = await home.readAlertDetail('alr_v01');
    const v = await view('alr_v01');
    expect(v.title).toBe(d!.title);
    expect(v.cause).toBe(d!.cause);
    expect(v.state).toBe('open');
    expect(v.fix.href).toBe(fixHref(d!.fix));
    expect(v.fix.href.startsWith('/')).toBe(true);
    expect(v.fix.href.startsWith('//')).toBe(false);
    expect(safeNext(d!.fix.route)).toBe(d!.fix.route);
    expect(v.fix.href.split('#')[0]).toBe(d!.fix.route);
    expect(v.fix.href.split('#')[1]).toBe(d!.fix.anchor);
  });

  it('offers the actions the state allows, and only those', async () => {
    expect((await view('alr_v01')).actions.map((a) => a.kind)).toEqual(['acknowledge', 'resolve']);
    expect((await view('alr_v03')).actions.map((a) => a.kind)).toEqual(['resolve']);
    expect((await view('alr_v06')).actions.map((a) => a.kind)).toEqual(['reopen']);
  });

  it('resolve offers exactly the closed reason codes, in words', async () => {
    const resolve = (await view('alr_v01')).actions.find((a) => a.kind === 'resolve')!;
    expect(resolve.reasons!.map((r) => r.code)).toEqual([...RESOLVE_REASON_CODES]);
    expect(Object.keys(RESOLVE_REASON_WORDS).sort()).toEqual([...RESOLVE_REASON_CODES].sort());
    for (const r of resolve.reasons!)
      expect(r.label).toBe(RESOLVE_REASON_WORDS[r.code as keyof typeof RESOLVE_REASON_WORDS]);
    for (const a of (await view('alr_v01')).actions.filter((x) => x.kind !== 'resolve'))
      expect(a.reasons).toBeUndefined();
  });

  it('each action posts to AL route with its own key, and an MFA session may press it', async () => {
    const v = await view('alr_v01');
    for (const a of v.actions) {
      expect(a.path).toBe(`/api/ops/alerts/alr_v01/${a.kind}`);
      expect(a.key.length).toBeGreaterThan(1);
      expect(a.enabled).toBe(true);
      expect(a.hint).toBeNull();
    }
  });

  it('without the second factor every button is off and says why', async () => {
    const v = await view('alr_v01', false);
    expect(v.actions.length).toBeGreaterThan(0);
    for (const a of v.actions) {
      expect(a.enabled).toBe(false);
      expect(a.hint).toBe('needs your authenticator code');
    }
  });

  it('the built requests really move the alert, through the real routes', async () => {
    await seedAlert(rig.rig, { id: 'alr_walk', kind: 'frozen_order', reason: 'walk' });
    const step = async (verb: 'acknowledge' | 'resolve' | 'reopen', body: unknown = {}) => {
      const before = await view('alr_walk');
      const a = before.actions.find((x) => x.kind === verb)!;
      expect(a).toBeDefined();
      const res = await post(await route(verb), a.path, {
        session: rig.op,
        body,
        idem: key(),
        params: { id: 'alr_walk' },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { state: string };
    };
    expect((await step('acknowledge')).state).toBe('acknowledged');
    expect((await step('resolve', { reason_code: 'accepted_risk' })).state).toBe('resolved');
    expect((await step('reopen')).state).toBe('open');
  });

  it('a reason outside the closed list is not accepted by the route', async () => {
    const res = await go('resolve', 'alr_v02', { reason_code: 'because' });
    expect([400, 422]).toContain(res.status);
    expect((await view('alr_v02')).state).toBe('open');
  });

  it('shows the history of the alert, oldest first', async () => {
    const v = await view('alr_v06');
    expect(v.history.map((h) => h.text)).toEqual(['Resolved: false positive']);
  });
});

describe('money, the order link and the anchor', () => {
  it('says which money is at risk, in the currency of the order', () => {
    expect(moneyText(null)).toBeNull();
    expect(moneyText({ kind: 'order_total', minor: 1250, currency: 'USD' })).toBe(
      `Order total at risk: ${formatMinor(1250, 'USD')}`,
    );
    expect(moneyText({ kind: 'unit_amount', minor: 500, currency: 'GBP' })).toBe(
      `Item amount at risk: ${formatMinor(500, 'GBP')}`,
    );
    expect(moneyText({ kind: 'refund_amount', minor: 75, currency: 'EUR' })).toBe(
      `Refund amount at risk: ${formatMinor(75, 'EUR')}`,
    );
  });

  const entries = [
    { seq: 1, source: { table: 'orders', id: 'ord_1' } },
    { seq: 2, source: { table: 'order_units', id: 'unit_1' } },
    { seq: 4, source: { table: 'alerts', id: 'alr_a' } },
    { seq: 5, source: { table: 'alerts', id: 'alr_b' } },
    { seq: 6, source: { table: 'alerts', id: 'alr_a' } },
  ];
  it('finds the entry whose source is this alert, the first one if there are several', () => {
    expect(orderAnchor(entries, 'alr_a')).toBe('seq-4');
    expect(orderAnchor(entries, 'alr_b')).toBe('seq-5');
    expect(orderAnchor(entries, 'alr_none')).toBeNull();
    expect(orderAnchor([{ seq: 3, source: { table: 'orders', id: 'alr_a' } }], 'alr_a')).toBeNull();
  });

  it('the order link is the order page, at the anchor when there is one', () => {
    expect(orderHref('DL-1', 'seq-4')).toBe('/ops/money/orders/DL-1#seq-4');
    expect(orderHref('DL-1', null)).toBe('/ops/money/orders/DL-1');
    expect(orderHref('A B/ü', null)).toBe(`/ops/money/orders/${encodeURIComponent('A B/ü')}`);
  });

  it('the case link is the case page, and none when there is no case', () => {
    const base = {
      id: 'alr_x',
      kind: 'frozen_order',
      severity: 'critical',
      title: 'Order frozen',
      cause: 'c',
      state: 'open',
      order_ref: null,
      unit_id: null,
      money_at_risk: null,
      case_id: 'cas_9',
      fix: { route: '/ops/money', anchor: 'ops-orders' },
      next_action: 'n',
      created_at: '2026-11-05T10:00:00.000Z',
      history: [],
    } as unknown as Parameters<typeof alertDetailView>[0];
    const o = {
      mfa: true,
      keys: { acknowledge: 'a', resolve: 'b', reopen: 'c' },
      order_anchor: null,
    };
    expect(alertDetailView(base, o).case_href).toBe('/ops/buyers/cases/cas_9');
    expect(alertDetailView({ ...base, case_id: null }, o).case_href).toBeNull();
    expect(
      alertDetailView({ ...base, order_ref: 'DL-9' }, { ...o, order_anchor: 'seq-3' }).order_href,
    ).toBe('/ops/money/orders/DL-9#seq-3');
  });
});
