// CO-4 goal 5, hostile input: the refund rule of recovery cases follows only the refund requests of
// the case's own units, ignores what it cannot read, runs once under concurrent sweeps, and never
// reopens a case somebody else already settled. Real PGlite, synthetic rows only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyAutomaticRules, openCase, resolve } from './index';
import { makeWorld } from './world';
import type { World } from './world';

const operator = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;
const buyer1 = { kind: 'buyer', buyer_id: 'buy_1' } as const;

let w: World;
beforeAll(async () => {
  w = await makeWorld('rfa');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
});

let seq = 0;
async function requestRow(unit_id: string, capture_id: string, state: string): Promise<string> {
  seq += 1;
  const id = `rfr_a${seq}`;
  await w.insert('refund_requests', {
    id,
    unit_id,
    capture_id,
    amount_minor: 500,
    currency: 'USD',
    reason: 'x',
    requested_by: 'operator:opr_1',
    state,
    refund_id: state === 'requested' ? null : `RFA${seq}`,
  });
  return id;
}
async function pendingCase(n: number, ids?: (own: string) => string) {
  const item = await w.item(n);
  const own = await requestRow(item.unit_id, `CAP${n}`, 'requested');
  const c = await openCase(w.deps, {
    kind: 'refund_requested',
    entitlement_id: item.entitlement_id,
    opened_by: 'operator',
    actor: operator,
  });
  if (!c.ok) throw new Error('open failed');
  // The offer records what the refund path returned for each unit, so hostile ids are returned.
  const r = await resolve(
    {
      ...w.deps,
      requestRefund: () =>
        Promise.resolve({
          ok: true as const,
          value: { refund_request_id: ids === undefined ? own : ids(own) },
        }),
    },
    { case_id: c.value.case_id, action: 'offer_refund', by: operator, reason: 'x' },
  );
  if (!r.ok) throw new Error('offer failed');
  return { case_id: c.value.case_id, own, item };
}
const stateOf = async (case_id: string) =>
  (await w.db.query<{ state: string }>('SELECT state FROM recovery_cases WHERE id = $1', [case_id]))
    .rows[0]!.state;
const actionCount = async (case_id: string) =>
  (await w.db.query('SELECT 1 FROM recovery_actions WHERE case_id = $1', [case_id])).rows.length;
const sweep = () => applyAutomaticRules(w.deps, { max_items: 50 });

describe('the refund rule of cases, hostile input', () => {
  it('a completed request of ANOTHER unit named in the offer does not settle the case', async () => {
    const other = await w.item(2);
    const foreign = await requestRow(other.unit_id, 'CAP2', 'completed');
    const c = await pendingCase(1, () => foreign);
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
  });

  it('a foreign completed request beside the case own open request does not hide the open one', async () => {
    const other = await w.item(2);
    const foreign = await requestRow(other.unit_id, 'CAP2', 'completed');
    const c = await pendingCase(1, (own) => `${own},${foreign}`);
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [c.own]);
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refunded');
  });

  it('a foreign FAILED request named in the offer does not reopen the case', async () => {
    const other = await w.item(2);
    const foreign = await requestRow(other.unit_id, 'CAP2', 'failed');
    const c = await pendingCase(1, (own) => `${own},${foreign}`);
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [c.own]);
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refunded');
  });

  it('SQL in the id list is data', async () => {
    const c = await pendingCase(1, () => "x'); DROP TABLE refund_requests; --,rfr_1");
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
    expect((await w.db.query('SELECT 1 FROM refund_requests')).rows).toHaveLength(1);
  });

  it('a list of thousands of ids is not followed (a case has a handful of units)', async () => {
    const c = await pendingCase(1, (own) =>
      [own, ...Array.from({ length: 5000 }, (_, k) => `rfr_junk${k}`)].join(','),
    );
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [c.own]);
    await sweep();
    expect(await stateOf(c.case_id)).toBe('refund_pending');
  });

  it('two sweeps at once settle a case once', async () => {
    const c = await pendingCase(1);
    await w.db.query("UPDATE refund_requests SET state = 'failed' WHERE id = $1", [c.own]);
    const before = await actionCount(c.case_id);
    await Promise.all([sweep(), sweep(), sweep()]);
    expect(await stateOf(c.case_id)).toBe('diagnosing');
    expect(await actionCount(c.case_id)).toBe(before + 1);
    expect(
      (await w.db.query("SELECT 1 FROM alerts WHERE kind = 'refund_failed'")).rows,
    ).toHaveLength(1);
  });

  it('a case an operator closed meanwhile stays closed', async () => {
    const c = await pendingCase(1);
    await w.db.query("UPDATE recovery_cases SET state = 'closed' WHERE id = $1", [c.case_id]);
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [c.own]);
    await sweep();
    expect(await stateOf(c.case_id)).toBe('closed');
  });

  it('a buyer cannot move the case by resolving it', async () => {
    const c = await pendingCase(1);
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [c.own]);
    for (const action of [
      'restore',
      'credit',
      'close_not_charged',
      'offer_refund',
      'close_no_fault',
    ] as const) {
      const r = await resolve(w.deps, {
        case_id: c.case_id,
        action,
        by: buyer1,
        reason: 'x',
        credit_ms: 1,
      });
      expect(r.ok).toBe(false);
    }
    expect(await stateOf(c.case_id)).toBe('refund_pending');
  });

  it('a refund_pending case can no longer be resolved by hand while its refund is followed', async () => {
    const c = await pendingCase(1);
    const r = await resolve(w.deps, {
      case_id: c.case_id,
      action: 'close_no_fault',
      by: operator,
      reason: 'x',
    });
    expect(r).toEqual({ ok: false, error: { code: 'wrong_state' } });
  });

  it('two cases settle in one sweep', async () => {
    const c = await pendingCase(1);
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [c.own]);
    const other = await pendingCase(2);
    await w.db.query("UPDATE refund_requests SET state = 'completed' WHERE id = $1", [other.own]);
    await sweep();
    expect([await stateOf(c.case_id), await stateOf(other.case_id)]).toEqual([
      'refunded',
      'refunded',
    ]);
  });
});
