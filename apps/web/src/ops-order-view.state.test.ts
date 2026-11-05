// INT-OPS-A / OPS-A.4: the operator order page /ops/money/orders/[ref]. A summary, the TR1 operator timeline, one
// evidence button per unit and the one fix link of the catalogue. Identity (buyer name, whole PayPal ids, the
// request address) appears only on a session with the second factor (C3), proved by a deep scan of the whole view.
// Each timeline entry has the id seq-<n> from its TR1 seq, and an alert opens the page at the entry whose source
// is that alert (A7).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { Actor, TraceContext } from '@umsbx/contracts';
import { HARBOUR_FERRY, HARBOUR_TIDE, runPack } from './composite-support';
import { bootAlertRig } from './ops-alerts-support';
import type { AlertRig } from './ops-alerts-support';
import { alertDetailView, orderHref } from './lib/ops-alerts-view';
import { orderPageView } from './lib/ops-order-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const IP = 'ab'.repeat(32);
const ctx: TraceContext = {
  id: 'ctx_ord_a1',
  at: '2026-11-05T10:00:00.000Z',
  channel: 'web',
  actor_kind: 'operator',
  actor_id: 'vikram',
  on_behalf_of: null,
  mandate_id: null,
  mfa: true,
  req_id: 'req_ordpage1',
  ip_hash: IP,
  ua_family: 'curl',
  api_key_id: null,
  job: null,
  tool: null,
};

let rig: AlertRig;
let money: typeof import('./composition/ops-money');
let home: typeof import('./composition/ops-home');
let ref = '';
let units: string[] = [];
let buyerName = '';
let providerIds: string[] = [];
const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };

beforeAll(async () => {
  rig = await bootAlertRig();
  money = await import('./composition/ops-money');
  home = await import('./composition/ops-home');
  const app = rig.rig.app;
  const started = await runPack(app, rig.rig.buyerA, [HARBOUR_TIDE, HARBOUR_FERRY], ['happy']);
  ref = started.order_ref;
  const q = (s: string, p: unknown[] = []) => app.db.query<Record<string, string>>(s, p);
  units = (await q('SELECT id FROM order_units WHERE order_id = $1 ORDER BY id', [started.order_id])).rows.map((r) => r['id']!);
  buyerName = (await q('SELECT b.display_name AS n FROM buyers b JOIN orders o ON o.buyer_id = b.id WHERE o.id = $1', [started.order_id])).rows[0]!['n']!;
  providerIds = [
    ...(await q('SELECT provider_order_id AS v FROM provider_orders WHERE order_id = $1', [started.order_id])).rows.map((r) => r['v']!),
    ...(await q('SELECT capture_id AS v FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL', [started.order_id])).rows.map((r) => r['v']!),
  ];
  await withTraceContext(ctx, () =>
    app.db.query(
      `INSERT INTO alerts (id, kind, order_id, detail, created_at, updated_at)
       SELECT 'alr_ordpage', 'payment_unresolved', id, '{"reason":"order page test"}'::jsonb, now(), now() FROM orders WHERE order_ref = $1`,
      [ref],
    ),
  );
});
afterAll(async () => rig?.rig.app.close());

describe('the order page view', () => {
  it('the order has two units, so the test is about a two unit order', () => {
    expect(units).toHaveLength(2);
    expect(providerIds.length).toBeGreaterThanOrEqual(3);
    expect(buyerName.length).toBeGreaterThan(2);
  });

  it('shows the summary: reference, status, total, environment and the units', async () => {
    const v = (await money.readOrderPage(MFA, ref))!;
    expect(v.order_ref).toBe(ref);
    expect(v.environment).toBe('dryrun');
    expect(v.status.length).toBeGreaterThan(1);
    expect(v.total_text).toMatch(/\$\d+\.\d\d/);
    expect(v.units.map((u) => u.id).sort()).toEqual([...units].sort());
    for (const u of v.units) {
      expect(u.amount_text).toMatch(/\$\d+\.\d\d/);
      expect(u.status.length).toBeGreaterThan(1);
    }
  });

  it('answers null for an order that is not there', async () => {
    expect(await money.readOrderPage(MFA, 'no-such-order')).toBeNull();
    expect(await money.readOrderPage({ kind: 'buyer', buyer_id: 'x' } as never, ref)).toBeNull();
  });

  it('without the second factor: no buyer name, no whole PayPal id, no address (deep scan)', async () => {
    const v = (await money.readOrderPage(PLAIN, ref))!;
    const text = JSON.stringify(v);
    expect(text).not.toContain(buyerName);
    for (const id of providerIds) expect(text).not.toContain(id);
    expect(text).not.toContain(IP);
    expect(text).not.toContain(IP.slice(0, 8));
    expect(text).not.toContain('req_ordpage1');
    expect(text).not.toContain('curl');
    expect(v.buyer).toBeNull();
    for (const id of providerIds) expect(text).toContain(`…${id.slice(-4)}`);
  });

  it('with the second factor: the buyer, the whole ids and the address prefix', async () => {
    const v = (await money.readOrderPage(MFA, ref))!;
    const text = JSON.stringify(v);
    expect(v.buyer).toBe(buyerName);
    for (const id of providerIds) expect(text).toContain(id);
    expect(text).toContain(IP.slice(0, 8));
    expect(text).not.toContain(IP);
    expect(text).toContain('req_ordpage1');
  });

  it('a two unit order has two evidence buttons, one link per unit; without the code they are off', async () => {
    const withCode = (await money.readOrderPage(MFA, ref))!;
    expect(withCode.units.map((u) => u.evidence)).toHaveLength(2);
    for (const u of withCode.units) {
      expect(u.evidence).toEqual({ label: 'Evidence pack', href: `/api/ops/units/${u.id}/evidence.html`, enabled: true });
    }
    const without = (await money.readOrderPage(PLAIN, ref))!;
    for (const u of without.units) {
      expect(u.evidence).toEqual({ label: 'needs your authenticator code', href: null, enabled: false });
    }
  });

  it('the timeline is TR1: every row has the id seq-<n> of its TR1 seq, and no id is used twice', async () => {
    const v = (await money.readOrderPage(MFA, ref))!;
    expect(v.timeline.kind).toBe('rows');
    if (v.timeline.kind !== 'rows') return;
    const direct = (await rig.rig.app.trace.opsTimeline({ order_ref: ref, mfa: true }))!;
    expect(v.timeline.rows.length).toBe(direct.entries.length);
    expect(v.anchors).toEqual(direct.entries.map((e) => `seq-${e.seq}`));
    expect(new Set(v.anchors).size).toBe(v.anchors.length);
    const tl = source('ui/Timeline.tsx');
    expect(tl).toMatch(/id=\{`seq-\$\{String\(r\.seq\)\}`\}|id=\{`seq-\$\{r\.seq\}`\}/);
  });

  it('the one fix link is the catalogue fix of the order alert, and it is inside the shell', async () => {
    const v = (await money.readOrderPage(MFA, ref))!;
    const d = (await home.readAlertDetail('alr_ordpage'))!;
    expect(v.fix).toEqual({ href: `${d.fix.route}#${d.fix.anchor}`, label: 'Open the fix' });
    expect(v.alerts.map((a) => a.id)).toEqual(['alr_ordpage']);
    expect(v.alerts[0]!.href).toBe('/ops/alerts/alr_ordpage');
  });

  it('with no alert on the order there is no fix link', () => {
    const v = orderPageView({
      order: { order_ref: 'DL-0', status: 'paid', total_minor: 500, currency: 'USD', environment: 'dryrun', created_at: '2026-11-05T10:00:00.000Z', buyer_name: null },
      units: [],
      entries: [],
      truncated: false,
      words: {},
      alerts: [],
      mfa: false,
    });
    expect(v.fix).toBeNull();
    expect(v.alerts).toEqual([]);
    expect(v.timeline.kind).toBe('empty');
  });
});

describe('an alert opens the order at its own entry (A7)', () => {
  it('the alert page link ends #seq-<n> of the entry whose source is that alert', async () => {
    const page = (await home.readAlertPage(MFA, 'alr_ordpage'))!;
    const direct = (await rig.rig.app.trace.opsTimeline({ order_ref: ref, mfa: true }))!;
    const mine = direct.entries.find((e) => e.source.table === 'alerts' && e.source.id === 'alr_ordpage')!;
    expect(mine).toBeDefined();
    const v = alertDetailView(page.detail, { mfa: true, keys: page.keys, order_anchor: page.order_anchor });
    expect(page.order_anchor).toBe(`seq-${mine.seq}`);
    expect(v.order_href).toBe(`${orderHref(ref, null)}#seq-${mine.seq}`);
    expect(v.order_href).toMatch(/^\/ops\/money\/orders\/[^#]+#seq-\d+$/);
  });

  it('the page has that entry under that id', async () => {
    const v = (await money.readOrderPage(MFA, ref))!;
    const direct = (await rig.rig.app.trace.opsTimeline({ order_ref: ref, mfa: true }))!;
    const i = direct.entries.findIndex((e) => e.source.table === 'alerts' && e.source.id === 'alr_ordpage');
    expect(v.anchors[i]).toBe(`seq-${direct.entries[i]!.seq}`);
  });

  it('an alert with no order has no order link, and one with an unknown order no anchor', async () => {
    await rig.rig.app.db.query(
      `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ('alr_noorder', 'webhook_failing', '{"reason":"x"}'::jsonb, now(), now())`,
    );
    const page = (await home.readAlertPage(MFA, 'alr_noorder'))!;
    expect(page.order_anchor).toBeNull();
    expect(alertDetailView(page.detail, { mfa: true, keys: page.keys, order_anchor: null }).order_href).toBeNull();
    expect(await home.readAlertPage(MFA, 'alr_missing')).toBeNull();
  });
});

describe('the page itself (source as text)', () => {
  const page = source('app/ops/money/orders/[ref]/page.tsx');
  it('is operator only and reads through ops-money.ts alone', () => {
    expect(page).toMatch(/actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/money'\)/);
    expect(page).toMatch(/from '(\.\.\/)+composition\/ops-money'/);
    expect(page).not.toMatch(/server\/access|composition\.server/);
    expect(page).not.toMatch(/style=|dangerouslySetInnerHTML/);
  });
  it('does not draw the verified mark itself: the Timeline component owns it (S1)', () => {
    expect(page).not.toMatch(/timelineMark|verified/);
    expect(page).toContain('<Timeline');
  });
});
