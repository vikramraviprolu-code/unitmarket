// INT-OPS-C / OPS-C.5: the money-flow strip on operator Home. Counts for the 24 hours ending at the injected `now`
// (Find, Quote, Approve, Pay, Unlock, Refund), plus the two stuck counts. Each count equals its table rule; rows
// just inside and just outside the window prove the edges.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld, buy, postRefund } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { FLOW_STAGES, FLOW_WINDOW_MS, flowWindow, moneyFlowView } from './lib/money-flow-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };
const MARGIN = 60_000;

let w: RefundWorld;
let home: typeof import('./composition/ops-home');
const units: BoughtUnit[] = [];
let now0 = 0;
let before: Record<string, number> = {};
const iso = (ms: number): string => new Date(ms).toISOString();

async function n(sql: string, params: unknown[]): Promise<number> {
  const r = await w.app.db.query<{ c: string | number }>(sql, params);
  return Number(r.rows[0]?.c ?? 0);
}

/** The table rules of the spec, written out again on their own. */
async function expected(nowIso: string) {
  const from = iso(Date.parse(nowIso) - FLOW_WINDOW_MS);
  const p = [from, nowIso];
  return {
    find: await n('SELECT count(*) AS c FROM briefs WHERE created_at > $1 AND created_at <= $2', p),
    quote: await n(
      'SELECT count(*) AS c FROM quotes WHERE created_at > $1 AND created_at <= $2',
      p,
    ),
    approve: await n('SELECT count(*) AS c FROM approvals WHERE used_at > $1 AND used_at <= $2', p),
    pay: await n(
      'SELECT count(*) AS c FROM order_units WHERE captured_verified_at > $1 AND captured_verified_at <= $2',
      p,
    ),
    unlock: await n(
      "SELECT count(*) AS c FROM access_events WHERE kind = 'access_ready' AND at > $1 AND at <= $2",
      p,
    ),
    refund: await n(
      "SELECT count(*) AS c FROM refund_requests WHERE state = 'completed' AND updated_at > $1 AND updated_at <= $2",
      p,
    ),
    stuck_sent: await n(
      "SELECT count(*) AS c FROM operations WHERE state = 'sent' AND lease_until < $1",
      [nowIso],
    ),
    stuck_unknown: await n(
      "SELECT count(*) AS c FROM operations WHERE state = 'unknown' AND reconcile_until < $1",
      [nowIso],
    ),
  };
}

const asMap = (r: Awaited<ReturnType<typeof home.readMoneyFlow>>): Record<string, number> => {
  if (r === null) throw new Error('expected a read');
  return {
    ...Object.fromEntries(r.stages.map((s) => [s.key, s.count])),
    stuck_sent: r.stuck.sent,
    stuck_unknown: r.stuck.unknown,
  };
};

beforeAll(async () => {
  w = await bootRefundWorld();
  home = await import('./composition/ops-home');
  units.push(await buy(w, { offer: 'knot-notebook', option: 'online_read' }));
  units.push(await buy(w, { offer: 'harbour-fees', option: 'online_read' }));
  units.push(await buy(w, { offer: 'tide-tables', option: 'online_read', who: 'B' }));
  const r = await postRefund(w, w.op, {
    unit_id: units[0]!.unit_id,
    amount_minor: null,
    reason: 'Customer asked for a refund',
  });
  if (r.status !== 200) throw new Error(`refund ${r.status}`);
  before = asMap(await home.readMoneyFlow(MFA));
  now0 = w.app.security.clock.now().getTime();
  const inside = iso(now0 - FLOW_WINDOW_MS + MARGIN);
  const outside = iso(now0 - FLOW_WINDOW_MS - MARGIN);
  const later = iso(now0 + FLOW_WINDOW_MS);
  const buyer = (w.actorA as { buyer_id: string }).buyer_id;
  for (const [id, at] of [
    ['brf_opsc_in', inside],
    ['brf_opsc_out', outside],
    ['brf_opsc_late', later],
  ] as const)
    await w.app.db.query(
      `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
       VALUES ($1, $2, 'tide tables', '{}'::jsonb, 'v1', NULL, $3, $3)`,
      [id, buyer, at],
    );
  for (const [id, at] of [
    ['quo_opsc_in', inside],
    ['quo_opsc_out', outside],
  ] as const)
    await w.app.db.query(
      `INSERT INTO quotes (id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, created_at, updated_at)
       SELECT $1, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, $2, $2
         FROM quotes ORDER BY id LIMIT 1`,
      [id, at],
    );
  // Pay and Refund edges: one unit moved just outside, one refund moved just inside.
  await w.app.db.query('UPDATE order_units SET captured_verified_at = $2 WHERE id = $1', [
    units[1]!.unit_id,
    outside,
  ]);
  await w.app.db.query("UPDATE refund_requests SET updated_at = $1 WHERE state = 'completed'", [
    inside,
  ]);
  // Stuck operations: one sent past its lease, one sent within it, one unknown past its reconcile time, one not.
  const ops: [string, string, string | null, string | null][] = [
    ['opn_opsc_s1', 'sent', iso(now0 - MARGIN), null],
    ['opn_opsc_s2', 'sent', later, null],
    ['opn_opsc_u1', 'unknown', null, iso(now0 - MARGIN)],
    ['opn_opsc_u2', 'unknown', null, later],
  ];
  for (const [id, state, lease, reconcile] of ops)
    await w.app.db.query(
      `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at, idem_safe_until,
                               lease_until, next_retry_at, reconcile_until, failure_reason, created_at, updated_at)
       SELECT $1, order_id, unit_id, kind, $2, 1, $5, first_sent_at, idem_safe_until, $3, NULL, $4, NULL, created_at, updated_at
         FROM operations ORDER BY id LIMIT 1`,
      [id, state, lease, reconcile, `${id}_req`],
    );
});
afterAll(async () => w.app.close());

describe('the window and the stages (pure)', () => {
  it('the window is the 24 hours ending at now, open at the start and closed at the end', () => {
    expect(FLOW_WINDOW_MS).toBe(86_400_000);
    expect(flowWindow('2026-11-05T12:00:00.000Z')).toEqual({
      from: '2026-11-04T12:00:00.000Z',
      to: '2026-11-05T12:00:00.000Z',
    });
  });
  it('the stages are the six of the spec, in order', () => {
    expect(FLOW_STAGES.map((s) => [s.key, s.label])).toEqual([
      ['find', 'Find'],
      ['quote', 'Quote'],
      ['approve', 'Approve'],
      ['pay', 'Pay'],
      ['unlock', 'Unlock'],
      ['refund', 'Refund'],
    ]);
  });
  it('moneyFlowView puts the counts in stage order and marks stuck work', () => {
    const v = moneyFlowView({
      counts: { find: 1, quote: 2, approve: 3, pay: 4, unlock: 5, refund: 6 },
      stuck: { sent: 0, unknown: 2 },
      window: flowWindow('2026-11-05T12:00:00.000Z'),
    });
    expect(v.stages.map((s) => s.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(v.stuck).toEqual({ sent: 0, unknown: 2 });
    expect(v.stuckAny).toBe(true);
    expect(
      moneyFlowView({
        counts: { find: 0, quote: 0, approve: 0, pay: 0, unlock: 0, refund: 0 },
        stuck: { sent: 0, unknown: 0 },
        window: flowWindow('2026-11-05T12:00:00.000Z'),
      }).stuckAny,
    ).toBe(false);
  });
});

describe('OPS-C.5 the counts', () => {
  it('each stage count equals its table rule, and stuck counts equal the two operation rules', async () => {
    const r = await home.readMoneyFlow(MFA);
    expect(r!.window.to).toBe(r!.now);
    expect(asMap(r)).toEqual(await expected(r!.now));
  });

  it('rows just inside count and rows just outside or later do not', async () => {
    // Read before the edge rows were added, and again now: only the rows inside the window moved a count.
    const after = asMap(await home.readMoneyFlow(MFA));
    const d = (k: string): number => after[k]! - before[k]!;
    expect(d('find')).toBe(1);
    expect(d('quote')).toBe(1);
    expect(d('pay')).toBe(-1);
    expect(d('refund')).toBe(0);
    expect(after['refund']).toBe(1);
    expect(d('approve')).toBe(0);
    expect(d('unlock')).toBe(0);
    expect(d('stuck_sent')).toBe(1);
    expect(d('stuck_unknown')).toBe(1);
  });

  it('an operator without the second factor sees the same counts (no identity), anyone else nothing', async () => {
    expect(asMap(await home.readMoneyFlow(PLAIN))).toEqual(asMap(await home.readMoneyFlow(MFA)));
    expect(await home.readMoneyFlow(w.actorA)).toBeNull();
  });
});

describe('the strip on Home', () => {
  it('Home renders the MoneyFlow strip from ops-home', () => {
    const src = code('app/ops/page.tsx');
    expect(src).toContain('readMoneyFlow(');
    expect(src).toContain('<MoneyFlow');
    const strip = code('ui/ops/MoneyFlow.tsx');
    expect(strip).toMatch(/<ol[^>]*aria-label=/);
  });
});
