// INT-AL AL.1: the operator list of alerts with true totals, filters and keyset paging; each row carries order
// ref, unit, money at risk (by the catalogue) and the linked case where one exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAlert, listAlerts, resolveAlert, acknowledgeAlert } from './index';
import { START, ctxOf, makeWorld } from './world';
import type { World } from './world';

let w: World;
const ids: string[] = [];

beforeAll(async () => {
  w = await makeWorld('al-read');
  // 25 alerts: 5 orders, each order with 5 kinds. Created one second apart so the order is known.
  const kinds = [
    'payment_unresolved',
    'frozen_order',
    'refund_failed',
    'unexpected_capture',
    'reversal_hint',
  ];
  for (let o = 1; o <= 5; o++) await w.order(o, { amount: 100 * o });
  await w.refundRequest({ id: 'rfr_1', unit: 1, state: 'failed', amount: 70 });
  for (let i = 0; i < 25; i++) {
    const o = (i % 5) + 1;
    const kind = kinds[Math.floor(i / 5)]!;
    const at = new Date(Date.parse(START) + i * 1000).toISOString();
    ids.push(
      await w.alert({
        kind,
        order: o,
        unit: o,
        reason: `r${i}`,
        at,
        detail: kind === 'refund_failed' ? { refund_request_id: 'rfr_1' } : {},
      }),
    );
  }
  // a case on order 2 that points at the first alert of order 2 (index 1)
  await w.caseRow({ id: 'cas_1', order: 2 });
  await w.insert('recovery_actions', {
    id: 'rac_1',
    case_id: 'cas_1',
    action: 'opened',
    actor: 'system',
    detail: JSON.stringify({ alert_id: ids[1] }),
    at: START,
  });
  w.as(ctxOf());
});
afterAll(async () => w.close());

describe('list (AL.1)', () => {
  it('25 alerts at limit 20 come as 20 then 5, each page with total 25', async () => {
    const p1 = await listAlerts(w.db, { state: 'all', limit: 20 });
    expect(p1.items).toHaveLength(20);
    expect(p1.total).toBe(25);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await listAlerts(w.db, { state: 'all', limit: 20, cursor: p1.next_cursor! });
    expect(p2.items).toHaveLength(5);
    expect(p2.total).toBe(25);
    expect(p2.next_cursor).toBeNull();
    const seen = [...p1.items, ...p2.items].map((r) => r.id);
    expect(new Set(seen).size).toBe(25);
    // newest first: the last seeded alert leads
    expect(seen[0]).toBe(ids[24]);
    expect(seen[24]).toBe(ids[0]);
  });

  it('the default page is 25 and the largest is 100', async () => {
    expect((await listAlerts(w.db, {})).items).toHaveLength(25);
    expect((await listAlerts(w.db, { limit: 1000 })).items.length).toBeLessThanOrEqual(100);
  });

  it('filters narrow the list with true totals', async () => {
    const byKind = await listAlerts(w.db, { kind: 'frozen_order', limit: 2 });
    expect(byKind.total).toBe(5);
    expect(byKind.items).toHaveLength(2);
    expect(byKind.items.every((r) => r.kind === 'frozen_order')).toBe(true);
    const info = await listAlerts(w.db, { severity: 'info' });
    expect(info.items.every((r) => r.severity === 'info')).toBe(true);
    expect(info.total).toBe(info.items.length);
  });

  it('the state filter follows the latest event', async () => {
    await resolveAlert(w.deps, { alert_id: ids[0]!, reason_code: 'fixed_upstream' });
    await acknowledgeAlert(w.deps, { alert_id: ids[1]! });
    expect((await listAlerts(w.db, { state: 'resolved' })).total).toBe(1);
    expect((await listAlerts(w.db, { state: 'acknowledged' })).total).toBe(1);
    expect((await listAlerts(w.db, { state: 'open' })).total).toBe(23);
    expect((await listAlerts(w.db, { state: 'all' })).total).toBe(25);
  });

  it('a row has order ref, unit, money at risk by the catalogue, and the case id where one exists', async () => {
    const all = (await listAlerts(w.db, { state: 'all', limit: 100 })).items;
    const row = (i: number) => all.find((r) => r.id === ids[i])!;
    // index 1: payment_unresolved on order 2 (total 200), with the case
    expect(row(1).order_ref).toBe('ref_2');
    expect(row(1).unit_id).toBe('unt_2');
    expect(row(1).money_at_risk).toEqual({ kind: 'order_total', minor: 200, currency: 'USD' });
    expect(row(1).case_id).toBe('cas_1');
    expect(row(0).case_id).toBeNull();
    // index 10: refund_failed on order 1, money is the refund request amount
    expect(row(10).money_at_risk).toEqual({ kind: 'refund_amount', minor: 70, currency: 'USD' });
    // index 15: unexpected_capture is the unit amount
    expect(row(15).money_at_risk).toEqual({ kind: 'unit_amount', minor: 100, currency: 'USD' });
    // index 20: reversal_hint carries no money
    expect(row(20).money_at_risk).toBeNull();
    for (const r of all) {
      expect(r.title.length).toBeGreaterThan(3);
      expect(r.cause.length).toBeGreaterThan(10);
      expect(r.fix.route.startsWith('/')).toBe(true);
      expect(r.next_action.length).toBeGreaterThan(5);
    }
  });

  it('no row carries buyer or publisher identity or a PayPal id', async () => {
    const text = JSON.stringify((await listAlerts(w.db, { state: 'all', limit: 100 })).items);
    for (const bad of ['buy_1', 'pub_1', 'MERCH1', 'CAP1', 'sub_b1'])
      expect(text).not.toContain(bad);
  });

  it('one alert reads with its history', async () => {
    const a = await getAlert(w.db, ids[0]!);
    expect(a?.state).toBe('resolved');
    expect(a?.history.map((h) => h.kind)).toEqual(['resolved']);
    expect(a?.history[0]?.reason_code).toBe('fixed_upstream');
    expect(await getAlert(w.db, 'alr_missing')).toBeNull();
  });
});
