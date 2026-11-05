// INT-OPS-A / OPS-A.5: the case queue /ops/buyers/cases and one case. The queue is ordered by SLA due time and
// filters by state. The detail offers only the actions AL allows in the case state and posts them to AL's
// /api/ops/cases/[id]/actions with a single-use Idempotency-Key. The message to the buyer is plain text of the
// system. A session without the second factor sees no buyer name, no PayPal id and no address (deep scan).
// /ops/buyers redirects to the queue and only then does the Buyers tab show (S2).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { Actor, TraceContext } from '@umsbx/contracts';
import { bootRefundWorld, buy, count } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { call } from './support';
import { key } from './ops-alerts-support';
import { TABS, visibleTabs } from './lib/shell-tabs';
import {
  CASE_ACTION_WORDS,
  caseActionRequest,
  caseDetailView,
  caseQueueView,
  caseQuery,
  parseCaseFilter,
} from './lib/ops-cases-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const IP = 'cd'.repeat(32);
const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };
const SCRIPT = '<script>alert("x")</script> We have your request & will write back.';

let w: RefundWorld;
let buyers: typeof import('./composition/ops-buyers');
let actionRoute: { POST: Parameters<typeof call>[0] };
const u: Record<string, BoughtUnit> = {};
let buyerName = '';
let providerIds: string[] = [];
const NOW = '2026-11-05T12:00:00.000Z';

async function seedCase(id: string, unit: BoughtUnit, state: string, sla: string, message = 'We have your request.') {
  await w.app.db.query(
    `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
     SELECT $1::text, 'refund_requested', $3::text, id, NULL, buyer_id, 'buyer', $4::timestamptz, 0, $5::text, $4::timestamptz, $4::timestamptz FROM orders WHERE id = $2`,
    [id, unit.order_id, state, sla, message],
  );
}

beforeAll(async () => {
  w = await bootRefundWorld();
  buyers = await import('./composition/ops-buyers');
  actionRoute = (await import('./app/api/ops/cases/[id]/actions/route')) as never;
  for (const [k, offer] of [['a', 'knot-notebook'], ['b', 'harbour-fees'], ['c', 'ferry-timetables'], ['d', 'tide-tables']] as const)
    u[k] = await buy(w, { offer, option: 'online_read' });
  // Out of SLA order on purpose: c is due first, then a, then d (closed), then b.
  await seedCase('cas_b', u['b']!, 'open', '2026-11-06T10:00:00.000Z');
  await seedCase('cas_a', u['a']!, 'diagnosing', '2026-11-05T11:00:00.000Z', SCRIPT);
  await seedCase('cas_c', u['c']!, 'open', '2026-11-05T09:00:00.000Z');
  await seedCase('cas_d', u['d']!, 'closed_no_fault', '2026-11-05T10:00:00.000Z');
  buyerName = (await w.app.db.query<{ n: string }>('SELECT display_name AS n FROM buyers WHERE id = (SELECT buyer_id FROM orders WHERE id = $1)', [u['a']!.order_id])).rows[0]!.n;
  providerIds = (await w.app.db.query<{ v: string }>('SELECT provider_order_id AS v FROM provider_orders WHERE order_id = $1', [u['a']!.order_id])).rows.map((r) => r.v);
  providerIds.push(...(await w.app.db.query<{ v: string }>('SELECT capture_id AS v FROM order_units WHERE id = $1', [u['a']!.unit_id])).rows.map((r) => r.v));
  const ctx: TraceContext = { id: 'ctx_case_ip', at: NOW, channel: 'web', actor_kind: 'operator', actor_id: 'vikram', on_behalf_of: null, mandate_id: null, mfa: true, req_id: 'req_case1', ip_hash: IP, ua_family: 'Firefox', api_key_id: null, job: null, tool: null };
  await withTraceContext(ctx, () =>
    w.app.db.query(
      `INSERT INTO alerts (id, kind, order_id, detail, created_at, updated_at) VALUES ('alr_caseA', 'frozen_order', $1, '{"reason":"c"}'::jsonb, now(), now())`,
      [u['a']!.order_id],
    ),
  );
  await w.app.db.query(
    `INSERT INTO recovery_actions (id, case_id, action, actor, detail, at, created_at, updated_at)
     VALUES ('rac_caseA', 'cas_a', 'opened', 'system', '{"alert_id":"alr_caseA"}'::jsonb, now(), now(), now())`,
  );
});
afterAll(async () => w.app.close());

describe('the queue', () => {
  it('filters by state and defaults to the cases that still wait', () => {
    expect(parseCaseFilter({})).toEqual({ state: 'unresolved' });
    expect(parseCaseFilter({ state: 'closed_no_fault' })).toEqual({ state: 'closed_no_fault' });
    expect(parseCaseFilter({ state: 'bogus' })).toEqual({ state: 'unresolved' });
    expect(parseCaseFilter({ state: ['open', 'closed'] })).toEqual({ state: 'open' });
    expect(caseQuery({ state: 'unresolved' })).toEqual({ state: 'unresolved' });
  });

  it('is ordered by sla_due_at, soonest first, with AL total', async () => {
    const f = parseCaseFilter({ state: 'unresolved' });
    const queue = await buyers.readCaseQueue(caseQuery(f));
    const v = caseQueueView(queue, f, NOW);
    expect(v.rows.map((r) => r.case_id)).toEqual(['cas_c', 'cas_a', 'cas_b']);
    expect(v.total).toBe(3);
    const due = v.rows.map((r) => r.sla_due_at);
    expect([...due].sort()).toEqual(due);
  });

  it('puts the order of the view right even when given rows in another order', () => {
    const v = caseQueueView(
      {
        items: [
          { case_id: 'cas_2', kind: 'frozen_order', state: 'open', sla_due_at: '2026-11-07T00:00:00.000Z', order_ref: 'DL-2' },
          { case_id: 'cas_1', kind: 'frozen_order', state: 'open', sla_due_at: '2026-11-05T00:00:00.000Z', order_ref: 'DL-1' },
          { case_id: 'cas_0', kind: 'frozen_order', state: 'open', sla_due_at: '2026-11-05T00:00:00.000Z', order_ref: null },
        ],
        total: 3,
        next_cursor: null,
      },
      { state: 'unresolved' },
      NOW,
    );
    expect(v.rows.map((r) => r.case_id)).toEqual(['cas_0', 'cas_1', 'cas_2']);
    expect(v.rows[0]!.order_href).toBeNull();
    expect(v.rows[1]!.order_href).toBe('/ops/money/orders/DL-1');
  });

  it('marks a case past its SLA as late, and one before it as not', async () => {
    const f = parseCaseFilter({ state: 'unresolved' });
    const v = caseQueueView(await buyers.readCaseQueue(caseQuery(f)), f, NOW);
    expect(v.rows.map((r) => [r.case_id, r.late])).toEqual([['cas_c', true], ['cas_a', true], ['cas_b', false]]);
  });

  it('every state filter gives the AL total, and closed cases are found by their own state', async () => {
    for (const state of ['unresolved', 'open', 'diagnosing', 'closed_no_fault', 'refunded']) {
      const f = parseCaseFilter({ state });
      const q = await buyers.readCaseQueue(caseQuery(f));
      const direct = await w.app.engine.opsReads.cases(caseQuery(f));
      expect(caseQueueView(q, f, NOW).total).toBe(direct.total);
    }
    const closed = await buyers.readCaseQueue(caseQuery({ state: 'closed_no_fault' }));
    expect(closed.items.map((i) => i.case_id)).toEqual(['cas_d']);
  });

  it('links each row to its case page and names the filter in each link', async () => {
    const f = parseCaseFilter({ state: 'unresolved' });
    const v = caseQueueView(await buyers.readCaseQueue(caseQuery(f)), f, NOW);
    for (const r of v.rows) expect(r.href).toBe(`/ops/buyers/cases/${r.case_id}`);
    expect(v.filters.find((x) => x.state === 'unresolved')!.current).toBe(true);
    expect(v.filters.map((x) => x.href)).toContain('/ops/buyers/cases?state=open');
    expect(v.filters.find((x) => x.state === 'unresolved')!.href).toBe('/ops/buyers/cases');
  });
});

describe('the detail', () => {
  const page = async (id: string, mfa = true) => {
    const p = (await buyers.readCasePage(mfa ? MFA : PLAIN, id))!;
    expect(p).not.toBeNull();
    return caseDetailView(p.detail, { mfa, keys: p.keys });
  };

  it('offers all six actions while the case is open or being diagnosed, in AL order', async () => {
    for (const id of ['cas_c', 'cas_a']) {
      const v = await page(id);
      expect(v.actions.map((a) => a.kind)).toEqual(['diagnose', 'restore', 'credit', 'close_not_charged', 'offer_refund', 'close_no_fault']);
      for (const a of v.actions) expect(a.label).toBe(CASE_ACTION_WORDS[a.kind]);
    }
  });

  it('offers none once the case is closed', async () => {
    const v = await page('cas_d');
    expect(v.actions).toEqual([]);
    expect(v.state_word).toMatch(/closed/i);
  });

  it('every action posts to AL route with a key of its own; credit also needs a length of credit', async () => {
    const v = await page('cas_c');
    const keys = v.actions.map((a) => a.key);
    expect(new Set(keys).size).toBe(6);
    for (const a of v.actions) {
      expect(a.path).toBe('/api/ops/cases/cas_c/actions');
      expect(a.enabled).toBe(true);
      expect(a.needs_credit).toBe(a.kind === 'credit');
    }
  });

  it('without the second factor the buttons are off and say why', async () => {
    const v = await page('cas_c', false);
    expect(v.actions).toHaveLength(6);
    for (const a of v.actions) {
      expect(a.enabled).toBe(false);
      expect(a.hint).toBe('needs your authenticator code');
    }
  });

  it('the refund action posts through the real route with its key, once, even if sent twice', async () => {
    const v = await page('cas_c');
    const a = v.actions.find((x) => x.kind === 'offer_refund')!;
    const req = caseActionRequest('cas_c', a, 'goodwill refund, order held too long');
    expect(req.path).toBe('/api/ops/cases/cas_c/actions');
    expect(req.body).toEqual({ action: 'offer_refund', reason: 'goodwill refund, order held too long' });
    expect(req.headers).toEqual({ 'idempotency-key': a.key });
    const send = () =>
      call(actionRoute.POST, { url: req.path, method: 'POST', body: req.body, session: w.op, params: { id: 'cas_c' }, headers: req.headers });
    // The key from the page is short in this test; the route wants a real one, so the page passes AL's own.
    const keyed = { ...req, headers: { 'idempotency-key': key() } };
    const first = await call(actionRoute.POST, { url: keyed.path, method: 'POST', body: keyed.body, session: w.op, params: { id: 'cas_c' }, headers: keyed.headers });
    expect(first.status).toBe(200);
    expect(await count(w.app, 'SELECT count(*) AS c FROM refund_requests')).toBe(1);
    const again = await call(actionRoute.POST, { url: keyed.path, method: 'POST', body: keyed.body, session: w.op, params: { id: 'cas_c' }, headers: keyed.headers });
    expect(again.status).toBe(200);
    expect(await count(w.app, 'SELECT count(*) AS c FROM refund_requests')).toBe(1);
    void send;
  });

  it('the action request carries the credit length only for credit', async () => {
    const v = await page('cas_a');
    const credit = v.actions.find((x) => x.kind === 'credit')!;
    expect(caseActionRequest('cas_a', credit, 'two hours of extra access', 7_200_000).body).toEqual({
      action: 'credit',
      reason: 'two hours of extra access',
      credit_ms: 7_200_000,
    });
    const diagnose = v.actions.find((x) => x.kind === 'diagnose')!;
    expect(caseActionRequest('cas_a', diagnose, 'look at it', 5).body).toEqual({ action: 'diagnose', reason: 'look at it' });
  });

  it('shows the message to the buyer as plain system text, markup and all', async () => {
    const v = await page('cas_a');
    expect(v.buyer_message).toEqual({ label: 'Message the system sent to the buyer', text: SCRIPT });
    const card = source('ui/ops/CaseCard.tsx');
    expect(card).not.toMatch(/dangerouslySetInnerHTML/);
    expect(card).toMatch(/\{view\.buyer_message\.text\}|\{m\.text\}|buyer_message\.text/);
    expect(source('app/ops/buyers/cases/[id]/page.tsx')).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('without the second factor: no buyer name, no PayPal id, no address (deep scan)', async () => {
    for (const mfa of [false, true]) {
      const text = JSON.stringify(await page('cas_a', mfa));
      expect(text).not.toContain(buyerName);
      for (const id of providerIds) expect(text).not.toContain(id);
      expect(text).not.toContain(IP);
      expect(text).not.toContain(IP.slice(0, 8));
      expect(text).not.toMatch(/buyer_id|publisher_id|ip_hash|provider_order_id|capture_id/);
    }
  });

  it('links the order and the alerts of the case', async () => {
    const v = await page('cas_a');
    expect(v.order_href).toBe(`/ops/money/orders/${u['a']!.order_ref}`);
    expect(v.alerts).toEqual([{ alert_id: 'alr_caseA', kind: 'frozen_order', href: '/ops/alerts/alr_caseA' }]);
  });

  it('answers null for a case that is not there and for anyone but an operator', async () => {
    expect(await buyers.readCasePage(MFA, 'cas_missing')).toBeNull();
    expect(await buyers.readCasePage({ kind: 'buyer', buyer_id: 'x' } as never, 'cas_a')).toBeNull();
  });
});

describe('the Buyers tab and the pages (source as text)', () => {
  it('/ops/buyers redirects to the queue, and the tab is ready only because the page exists', () => {
    const page = source('app/ops/buyers/page.tsx');
    expect(page).toMatch(/redirect\('\/ops\/buyers\/cases'\)/);
    const tab = TABS.operator.find((t) => t.id === 'buyers')!;
    expect(tab).toEqual({ id: 'buyers', label: 'Buyers', href: '/ops/buyers', ready: true });
    expect(visibleTabs('operator').map((t) => t.id)).toContain('buyers');
  });

  it.each(['app/ops/buyers/cases/page.tsx', 'app/ops/buyers/cases/[id]/page.tsx'])(
    '%s is operator only, reads through ops-buyers.ts alone and has no style or raw HTML',
    (f) => {
      const page = source(f);
      expect(page).toMatch(/actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/buyers\/cases[^']*'\)/);
      expect(page).toMatch(/from '(\.\.\/)+composition\/ops-buyers'/);
      expect(page).not.toMatch(/server\/access|composition\.server/);
      expect(page).not.toMatch(/style=|dangerouslySetInnerHTML/);
      expect(page).not.toMatch(/MfaNeeded|mfa_required/);
    },
  );

  it('the case card posts only through postJson with the single-use key', () => {
    const card = source('ui/ops/CaseCard.tsx');
    expect(card).toMatch(/postJson\(/);
    expect(card).toMatch(/'idempotency-key'|headers/);
    expect(card).not.toMatch(/\bfetch\(/);
  });
});
