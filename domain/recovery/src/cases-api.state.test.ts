// INT-AL AL.7 and the AL.8 recovery side: the case queue and the case detail (read model), and the operator as
// the actor of an operator diagnose. The v1 answer says only that a buyer message exists; the composition read
// (with_message) returns the text, which is the system's own message to the buyer, not buyer input (R2-2).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_CASE_ACTIONS, allowedActions, diagnose, getCaseDetail, listCases } from './index';
import { HOUR, makeWorld } from './world';
import type { World } from './world';

const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;
let w: World;
beforeAll(async () => {
  w = await makeWorld('cases-api');
});
afterAll(async () => w.close());

const iso = (h: number): string =>
  new Date(Date.parse('2026-10-21T10:00:00.000Z') + h * HOUR).toISOString();
async function seedCase(i: {
  id: string;
  order: number;
  state: string;
  sla: number;
  kind?: string;
  message?: string;
}): Promise<void> {
  await w.insert('recovery_cases', {
    id: i.id,
    kind: i.kind ?? 'payment_unresolved',
    state: i.state,
    order_id: `ord_${i.order}`,
    entitlement_id: null,
    buyer_id: 'buy_1',
    opened_by: 'system',
    sla_due_at: iso(i.sla),
    credit_ms: 0,
    buyer_message: i.message ?? 'We are checking your payment and will tell you here.',
  });
}

beforeEach(async () => {
  await w.reset();
  for (const n of [1, 2, 3, 4]) await w.item(n, { unit_status: 'captured_verified' });
  await seedCase({ id: 'cas_a', order: 1, state: 'open', sla: 30 });
  await seedCase({ id: 'cas_b', order: 2, state: 'diagnosing', sla: 5 });
  await seedCase({ id: 'cas_c', order: 3, state: 'refund_pending', sla: 10 });
  await seedCase({ id: 'cas_d', order: 4, state: 'closed_no_fault', sla: 1 });
});

describe('case queue (AL.7)', () => {
  it('is ordered by sla_due_at, soonest first', async () => {
    const q = await listCases(w.db, {});
    expect(q.items.map((c) => c.case_id)).toEqual(['cas_d', 'cas_b', 'cas_c', 'cas_a']);
    expect(q.total).toBe(4);
  });

  it('filters by state with a true total, and pages by keyset', async () => {
    expect((await listCases(w.db, { state: 'open' })).items.map((c) => c.case_id)).toEqual([
      'cas_a',
    ]);
    const first = await listCases(w.db, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.total).toBe(4);
    const second = await listCases(w.db, { limit: 3, cursor: first.next_cursor! });
    expect(second.items.map((c) => c.case_id)).toEqual(['cas_a']);
    expect(second.next_cursor).toBeNull();
  });

  it('the filter "unresolved" gathers open, diagnosing and refund_pending', async () => {
    const q = await listCases(w.db, { state: 'unresolved' });
    expect(q.items.map((c) => c.case_id).sort()).toEqual(['cas_a', 'cas_b', 'cas_c']);
    expect(q.total).toBe(3);
  });
});

describe('case detail (AL.7)', () => {
  it('carries state, kind, sla, credit, linked alerts and the allowed actions', async () => {
    const alertId = await w.rawAlert({
      kind: 'payment_unresolved',
      order_id: 'ord_1',
      unit_id: 'unt_1',
      reason: 'r',
    });
    await w.insert('recovery_actions', {
      id: 'cac_x',
      case_id: 'cas_a',
      action: 'opened',
      actor: 'system',
      detail: JSON.stringify({ alert_id: alertId }),
      at: iso(0),
    });
    const d = (await getCaseDetail(w.db, 'cas_a'))!;
    expect(d).toMatchObject({
      case_id: 'cas_a',
      state: 'open',
      kind: 'payment_unresolved',
      sla_due_at: iso(30),
      credit_ms: 0,
      order_ref: 'ref_1',
      alerts: [{ alert_id: alertId, kind: 'payment_unresolved' }],
      buyer_message_present: true,
    });
    expect(d.allowed_actions).toEqual([...ALLOWED_CASE_ACTIONS]);
  });

  it('the allowed actions are the six, and none once the case is not open or diagnosing', async () => {
    expect([...ALLOWED_CASE_ACTIONS]).toEqual([
      'diagnose',
      'restore',
      'credit',
      'close_not_charged',
      'offer_refund',
      'close_no_fault',
    ]);
    expect(allowedActions('open')).toEqual([...ALLOWED_CASE_ACTIONS]);
    expect(allowedActions('diagnosing')).toEqual([...ALLOWED_CASE_ACTIONS]);
    for (const s of [
      'refund_pending',
      'restored',
      'closed_not_charged',
      'refunded',
      'closed_no_fault',
      'closed',
    ]) {
      expect(allowedActions(s as never)).toEqual([]);
    }
    expect((await getCaseDetail(w.db, 'cas_c'))!.allowed_actions).toEqual([]);
  });

  it('the v1 read has no message text; the composition read has it', async () => {
    const v1 = (await getCaseDetail(w.db, 'cas_a'))!;
    expect(JSON.stringify(v1)).not.toContain('We are checking your payment');
    expect('buyer_message' in v1).toBe(false);
    const full = (await getCaseDetail(w.db, 'cas_a', { with_message: true }))!;
    expect(full.buyer_message).toBe('We are checking your payment and will tell you here.');
  });

  it('carries no buyer or publisher identity', async () => {
    const text = JSON.stringify(await getCaseDetail(w.db, 'cas_a'));
    for (const bad of ['buy_1', 'pub_1', 'MERCH1', 'sub_']) expect(text).not.toContain(bad);
  });

  it('an unknown or malformed id reads as null', async () => {
    expect(await getCaseDetail(w.db, 'cas_zzz')).toBeNull();
    expect(await getCaseDetail(w.db, '')).toBeNull();
  });
});

describe('operator diagnose (AL.8)', () => {
  it('records the operator as the actor; without one it records system, as before', async () => {
    await diagnose(w.deps, { case_id: 'cas_a', actor: operator });
    await diagnose(w.deps, { case_id: 'cas_b' });
    const acts = (
      await w.db.query<{ case_id: string; actor: string; action: string }>(
        "SELECT case_id, actor, action FROM recovery_actions WHERE action = 'diagnosed' ORDER BY case_id",
      )
    ).rows;
    expect(acts).toEqual([{ case_id: 'cas_a', actor: 'operator:opr_1', action: 'diagnosed' }]);
    // cas_b was already diagnosing, so the second call moves nothing and records nothing
  });
});
