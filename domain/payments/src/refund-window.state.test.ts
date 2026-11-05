// BR-4: the refund deadline in requestRefund. The deadline is read from the terms frozen in the sale's
// approval snapshot (BR-3): start = access start, else the verified capture; the window is open strictly
// before start + refund.request_window days. Closed: refused with refund_window_closed unless the
// operator gives an override reason, which writes one audit event, refund_outside_window. A refund
// case the buyer opened in time keeps the window open for the operator. Version 1 sales (approved before
// BR-3) have no deadline. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@umsbx/contracts';
import { requestRefund } from './index';
import {
  OPERATOR,
  makeWorld,
  paid,
  rewriteSnapshot,
  setClockFacts,
  withAudit,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const DAY = 86_400_000;
const START = '2026-11-01T10:00:00.000Z';
const CAPTURE = '2026-10-31T09:30:00.000Z';
const at = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();
const DEADLINE = at(START, 7 * DAY);
const usd = (minor: number) => ({ currency: 'USD', minor });

async function unitOf(order_id: Id): Promise<{ id: string; entitlement_id: string }> {
  return (
    await w.rows<{ id: string; entitlement_id: string }>(
      'SELECT u.id, e.id AS entitlement_id FROM order_units u JOIN entitlements e ON e.unit_id = u.id WHERE u.order_id = $1',
      [order_id],
    )
  )[0]!;
}
async function sale(facts?: { access_started_at: string | null; captured_verified_at: string }) {
  w = await makeWorld();
  const a = await paid(w);
  await setClockFacts(
    w,
    a.order_id,
    facts ?? { access_started_at: START, captured_verified_at: CAPTURE },
  );
  return { a, unit: await unitOf(a.order_id) };
}
function ask(unit_id: string, o: { override_reason?: string; amount?: number | null } = {}) {
  return requestRefund(withAudit(w), {
    unit_id,
    amount: o.amount === undefined ? null : o.amount === null ? null : usd(o.amount),
    reason: 'goodwill',
    actor: OPERATOR,
    ...(o.override_reason !== undefined ? { override_reason: o.override_reason } : {}),
  });
}
const auditActions = async () =>
  (await w.rows<{ action: string }>('SELECT action FROM audit_log ORDER BY created_at, id')).map(
    (r) => r.action,
  );
const requests = () =>
  w.rows<{ id: string; state: string }>('SELECT id, state FROM refund_requests');
let caseSeq = 0;
async function openCaseAt(
  order_id: Id,
  entitlement_id: string | null,
  created_at: string,
  state = 'open',
  kind = 'refund_requested',
) {
  await w.insert('recovery_cases', {
    id: `cas_t${(caseSeq += 1)}`,
    kind,
    state,
    order_id,
    entitlement_id,
    buyer_id: 'buy_A',
    opened_by: 'buyer',
    sla_due_at: at(created_at, DAY),
    credit_ms: 0,
    buyer_message: 'asked',
    created_at,
    updated_at: created_at,
  });
}

describe('requestRefund against the frozen refund window', () => {
  it('is open one millisecond before the deadline', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, -1));
    const r = await ask(unit.id);
    expect(r.ok).toBe(true);
    expect(await auditActions()).toEqual(['refund.requested']);
  });

  it('is closed at exactly the deadline, and nothing is stored', async () => {
    const { unit } = await sale();
    w.clock.set(DEADLINE);
    const r = await ask(unit.id);
    expect(r).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
    expect(await requests()).toEqual([]);
    expect(await auditActions()).toEqual([]);
  });

  it('is closed after the deadline', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, 1));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
    w.clock.set(at(DEADLINE, 30 * DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
    expect(await requests()).toEqual([]);
  });

  it('counts from the access start, not from an earlier capture', async () => {
    const { unit } = await sale({
      access_started_at: START,
      captured_verified_at: at(START, -2 * DAY),
    });
    // capture + 7 days has passed, access start + 7 days has not
    w.clock.set(at(START, 6 * DAY));
    expect((await ask(unit.id)).ok).toBe(true);
  });

  it('counts from the verified capture when access has not started', async () => {
    const { unit } = await sale({ access_started_at: null, captured_verified_at: CAPTURE });
    w.clock.set(at(CAPTURE, 7 * DAY - 1));
    expect((await ask(unit.id)).ok).toBe(true);
  });

  it('is closed from the capture time plus the window when access has not started', async () => {
    const { unit } = await sale({ access_started_at: null, captured_verified_at: CAPTURE });
    w.clock.set(at(CAPTURE, 7 * DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('follows a frozen window of three days', async () => {
    const { a, unit } = await sale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      const terms = s['terms'] as { values: Record<string, number> };
      return { ...s, terms: { ...terms, values: { ...terms.values, 'refund.request_window': 3 } } };
    });
    w.clock.set(at(START, 3 * DAY - 1));
    expect((await ask(unit.id)).ok).toBe(true);
  });

  it('is closed at three days when the frozen window is three days', async () => {
    const { a, unit } = await sale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      const terms = s['terms'] as { values: Record<string, number> };
      return { ...s, terms: { ...terms, values: { ...terms.values, 'refund.request_window': 3 } } };
    });
    w.clock.set(at(START, 3 * DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });
});

describe('the operator override', () => {
  it('proceeds after the deadline with a reason and writes one refund_outside_window audit row', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, 2 * DAY));
    const r = await ask(unit.id, { override_reason: 'goodwill after outage, ticket 4411' });
    expect(r.ok).toBe(true);
    expect(await auditActions()).toEqual(['refund.requested', 'refund_outside_window']);
    const row = (
      await w.rows<{
        actor_id: string;
        reason: string;
        target: string;
        detail: Record<string, unknown>;
      }>(
        "SELECT actor_id, reason, target, detail FROM audit_log WHERE action = 'refund_outside_window'",
      )
    )[0]!;
    expect(row.actor_id).toBe('opr_1');
    expect(row.reason).toBe('goodwill after outage, ticket 4411');
    expect(row.target).toBe((await requests())[0]!.id);
    expect(row.detail).toMatchObject({ unit_id: unit.id, deadline: DEADLINE });
  });

  it('writes no override audit row when the window is still open', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, -DAY));
    expect((await ask(unit.id, { override_reason: 'not needed here' })).ok).toBe(true);
    expect(await auditActions()).toEqual(['refund.requested']);
  });

  it('an override at exactly the deadline is needed and recorded', async () => {
    const { unit } = await sale();
    w.clock.set(DEADLINE);
    expect((await ask(unit.id, { override_reason: 'at the line' })).ok).toBe(true);
    expect(await auditActions()).toContain('refund_outside_window');
  });

  it('a replay of the same refund while it is open writes no second audit row', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, DAY));
    expect((await ask(unit.id, { override_reason: 'ticket 4411 goodwill' })).ok).toBe(true);
    const again = await ask(unit.id, { override_reason: 'ticket 4411 goodwill' });
    expect(again).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
    expect((await auditActions()).filter((x) => x === 'refund_outside_window')).toHaveLength(1);
    expect(await requests()).toHaveLength(1);
  });

  it('a refused override (closed window, bad reason) stores nothing', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id, { override_reason: 'ab' })).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
    expect(await requests()).toEqual([]);
    expect(await auditActions()).toEqual([]);
  });
});

describe('a refund case the buyer opened in time', () => {
  it('lets the operator refund after the deadline without an override', async () => {
    const { a, unit } = await sale();
    await openCaseAt(a.order_id, unit.entitlement_id, at(START, 6 * DAY));
    w.clock.set(at(DEADLINE, 3 * DAY));
    expect((await ask(unit.id)).ok).toBe(true);
    expect(await auditActions()).toEqual(['refund.requested']);
  });

  it('counts a case in refund_pending and diagnosing the same way', async () => {
    for (const state of ['diagnosing', 'refund_pending']) {
      const { a, unit } = await sale();
      await openCaseAt(a.order_id, unit.entitlement_id, at(START, DAY), state);
      w.clock.set(at(DEADLINE, DAY));
      expect((await ask(unit.id)).ok).toBe(true);
    }
  });

  it('finds the case by order when it has no entitlement', async () => {
    const { a, unit } = await sale();
    await openCaseAt(a.order_id, null, at(START, DAY));
    w.clock.set(at(DEADLINE, DAY));
    expect((await ask(unit.id)).ok).toBe(true);
  });

  it('does not help when the case was opened after the deadline', async () => {
    const { a, unit } = await sale();
    await openCaseAt(a.order_id, unit.entitlement_id, at(DEADLINE, 1));
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('does not help when the case was opened exactly at the deadline', async () => {
    const { a, unit } = await sale();
    await openCaseAt(a.order_id, unit.entitlement_id, DEADLINE);
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('does not help when the case is settled (refunded, closed)', async () => {
    for (const state of ['refunded', 'closed', 'closed_no_fault', 'restored']) {
      const { a, unit } = await sale();
      await openCaseAt(a.order_id, unit.entitlement_id, at(START, DAY), state);
      w.clock.set(at(DEADLINE, DAY));
      expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
    }
  });

  it('does not help when the case is of another kind', async () => {
    const { a, unit } = await sale();
    await openCaseAt(a.order_id, unit.entitlement_id, at(START, DAY), 'open', 'delivery_failed');
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it("does not help when the case is another order's", async () => {
    const { unit } = await sale();
    const other = await paid(w, { buyer_id: 'buy_B' });
    const otherUnit = await unitOf(other.order_id);
    await openCaseAt(other.order_id, otherUnit.entitlement_id, at(START, DAY));
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });
});

describe('a version 1 sale (approved before the terms were recorded)', () => {
  it('has no deadline', async () => {
    const { a, unit } = await sale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      const { terms: _terms, ...rest } = s;
      return { ...rest, snapshot_version: '1' };
    });
    w.clock.set(at(START, 400 * DAY));
    expect((await ask(unit.id)).ok).toBe(true);
    expect(await auditActions()).toEqual(['refund.requested']);
  });
});

describe('the order of the guards', () => {
  it('answers over_refund before the window', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id, { amount: 99_999_999 })).toEqual({
      ok: false,
      error: { code: 'over_refund' },
    });
  });

  it('answers refund_in_flight before the window', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, -DAY));
    expect((await ask(unit.id)).ok).toBe(true);
    w.clock.set(at(DEADLINE, DAY));
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
  });

  it('answers refunds_off and mfa_required before the window', async () => {
    const { unit } = await sale();
    w.clock.set(at(DEADLINE, DAY));
    const noMfa = await requestRefund(withAudit(w), {
      unit_id: unit.id,
      amount: null,
      reason: 'goodwill',
      actor: { kind: 'operator', operator_id: 'opr_1', mfa: false },
    });
    expect(noMfa).toEqual({ ok: false, error: { code: 'mfa_required' } });
    w.switches.refunds_enabled = false;
    expect(await ask(unit.id)).toEqual({ ok: false, error: { code: 'refunds_off' } });
  });
});
