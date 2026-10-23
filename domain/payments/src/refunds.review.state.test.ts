// CO-4 review fixes (Opus review of ebb11df): F1 a dashboard refund held back by a request of ours
// is told to a human; LOW-1 a frozen unit takes no new refund request; LOW-2 refund ids match
// ignoring case and surrounding whitespace (for matching only, never for storing); LOW-3 a request
// that was never executed can be cancelled, which frees the unit; LOW-5 the local remaining comes
// from the ledger. Real PGlite, scripted PayPal. Synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { checkInvariants, executeRefund, reconcileOrder, requestRefund, runDue } from './index';
import { cancelRefundRequest } from './refunds';
import { OPERATOR, alertKinds, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const SEC = 1_000;
const usd = (minor: number) => ({ currency: 'USD', minor });

async function setup(price = 500) {
  w = await makeRemainingWorld({ price });
  const a = await paid(w);
  w.markReads();
  const unit = (
    await w.rows<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1',
      [a.order_id],
    )
  )[0]!;
  return { a, unit };
}
async function request(unit_id: string, minor: number | null): Promise<string> {
  const r = await requestRefund(w.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.refund_request_id;
}
const run = (id: string) => executeRefund(w.deps, { refund_request_id: id });
const reqRow = async (id: string) =>
  (
    await w.rows<{ state: string; refund_id: string | null; amount_minor: number }>(
      'SELECT state, refund_id, amount_minor FROM refund_requests WHERE id = $1',
      [id],
    )
  )[0]!;
const unitRow = async (id: string) =>
  (
    await w.rows<{ status: string; refunded_minor: number }>(
      'SELECT status, refunded_minor FROM order_units WHERE id = $1',
      [id],
    )
  )[0]!;
const ledger = async (unit_id: string) =>
  (
    await w.rows<{ refund_id: string; amount_minor: number }>(
      "SELECT refund_id, amount_minor FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund' ORDER BY refund_id",
      [unit_id],
    )
  ).map((x) => ({ refund_id: x.refund_id, minor: Number(x.amount_minor) }));
const alertRows = (order_id: string) =>
  w.rows<{ kind: string; detail: { reason: string } & Record<string, unknown> }>(
    'SELECT kind, detail FROM alerts WHERE order_id = $1 ORDER BY kind, id',
    [order_id],
  );
const reread = (order_id: string) => reconcileOrder(w.deps, { order_id, trigger: 'poll' });
const provider = async () =>
  (await w.rows<{ provider_order_id: string }>('SELECT provider_order_id FROM provider_orders'))[0]!
    .provider_order_id;
async function listOnly(
  list: { refund_id: string; status: string; amount: { currency: string; minor: number } }[],
) {
  await w.editNextRead(await provider(), (r) => ({
    ...r,
    units: r.units.map((u) => ({ ...u, refunds: list })),
  }));
}
async function invariantsHold(): Promise<void> {
  const r = await checkInvariants(w.db);
  expect(r.slice(0, 4).map((x) => x.ok)).toEqual([true, true, true, true]);
}
const noLanding = () => {
  // The refund call is lost and never reaches PayPal.
  w.paypal.refundCapture = (r) => {
    w.refundCalls.push({ request_id: r.request_id, capture_id: r.capture_id, amount: r.amount });
    return Promise.resolve({ kind: 'timeout' as const });
  };
};

describe('F1: a dashboard refund held back by a request of ours is told to a human', () => {
  it('a lost answer that never landed, then a full dashboard refund: an alert says it is waiting; access is untouched; one alert however often it is read', async () => {
    const { a, unit } = await setup();
    noLanding();
    const rq = await request(unit.id, 200);
    expect((await run(rq)).ok).toBe(false);
    expect((await reqRow(rq)).state).toBe('unknown');
    const dash = w.dashboard(unit.capture_id, 500);
    for (let k = 0; k < 6; k += 1) {
      await reread(a.order_id);
      w.tick(3_600 * SEC);
      await runDue(w.deps, { max_items: 10 });
    }
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([]);
    expect(await unitRow(unit.id)).toEqual({ status: 'captured_verified', refunded_minor: 0 });
    const held = (await alertRows(a.order_id)).filter((x) => x.kind === 'refund_unbooked');
    expect(held).toHaveLength(1);
    expect(held[0]?.detail).toEqual({
      reason: `listed_held_${dash}`,
      shown_minor: 500,
      held_by: 'request_without_refund_id',
    });
    await invariantsHold();
  });

  it('an unresolved request holds a listed refund back with the same alert, one per listed refund id', async () => {
    const { a, unit } = await setup();
    noLanding();
    const rq = await request(unit.id, 200);
    await run(rq);
    await w.rows("UPDATE refund_requests SET state = 'unresolved' WHERE id = $1", [rq]);
    const d1 = w.dashboard(unit.capture_id, 100);
    const d2 = w.dashboard(unit.capture_id, 150);
    await reread(a.order_id);
    await reread(a.order_id);
    const reasons = (await alertRows(a.order_id))
      .filter((x) => x.kind === 'refund_unbooked')
      .map((x) => x.detail.reason)
      .sort();
    expect(reasons).toEqual([`listed_held_${d1}`, `listed_held_${d2}`].sort());
    expect(await ledger(unit.id)).toEqual([]);
  });

  it('once the request is settled the held refund is booked and nothing more is raised', async () => {
    const { a, unit } = await setup();
    noLanding();
    const rq = await request(unit.id, 200);
    await run(rq);
    const dash = w.dashboard(unit.capture_id, 100);
    await reread(a.order_id);
    await w.rows("UPDATE refund_requests SET state = 'failed' WHERE id = $1", [rq]);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: dash, minor: 100 }]);
    expect((await alertRows(a.order_id)).filter((x) => x.kind === 'refund_unbooked')).toHaveLength(
      1,
    );
  });
});

describe('LOW-1: a frozen unit takes no new refund request', () => {
  const freeze = async (order_id: string) => {
    await listOnly([
      { refund_id: 'RFEUR', status: 'COMPLETED', amount: { currency: 'EUR', minor: 100 } },
    ]);
    await reread(order_id);
  };

  it('after a list froze the order, requestRefund answers unit_frozen and stores nothing', async () => {
    const { a, unit } = await setup();
    await freeze(a.order_id);
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unit_frozen' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
    const rest = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(rest).toEqual({ ok: false, error: { code: 'unit_frozen' } });
  });

  it('a clean read does not unfreeze: only a human clears it', async () => {
    const { a, unit } = await setup();
    await freeze(a.order_id);
    await reread(a.order_id);
    await reread(a.order_id);
    expect(
      (
        await w.rows<{ mismatch: boolean }>('SELECT mismatch FROM orders WHERE id = $1', [
          a.order_id,
        ])
      )[0]!.mismatch,
    ).toBe(true);
    expect(
      (
        await requestRefund(w.deps, {
          unit_id: unit.id,
          amount: usd(100),
          reason: 'x',
          actor: OPERATOR,
        })
      ).ok,
    ).toBe(false);
    await w.rows('UPDATE orders SET mismatch = false WHERE id = $1', [a.order_id]);
    expect(
      (
        await requestRefund(w.deps, {
          unit_id: unit.id,
          amount: usd(100),
          reason: 'x',
          actor: OPERATOR,
        })
      ).ok,
    ).toBe(true);
  });

  it('access is not changed by the freeze', async () => {
    const { a, unit } = await setup();
    await freeze(a.order_id);
    expect(
      await w.rows('SELECT money_state, access_state FROM entitlements WHERE unit_id = $1', [
        unit.id,
      ]),
    ).toEqual([{ money_state: 'captured', access_state: 'available' }]);
  });

  it('the order of the checks: not_captured and the operator checks come before unit_frozen', async () => {
    const { a, unit } = await setup();
    await freeze(a.order_id);
    expect(
      await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(100),
        reason: 'x',
        actor: { kind: 'operator', operator_id: 'opr_1', mfa: false },
      }),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(
      await requestRefund(w.deps, {
        unit_id: 'unt_unknown',
        amount: usd(100),
        reason: 'x',
        actor: OPERATOR,
      }),
    ).toEqual({ ok: false, error: { code: 'not_captured' } });
  });
});

describe('LOW-2: refund ids match ignoring case and surrounding whitespace, for matching only', () => {
  it('our own refund listed again with a lower-case id is not booked twice', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 200);
    await run(rq);
    const mine = (await reqRow(rq)).refund_id!;
    await listOnly([{ refund_id: mine.toLowerCase(), status: 'COMPLETED', amount: usd(200) }]);
    await reread(a.order_id);
    expect(mine).not.toBe(mine.toLowerCase());
    expect(await ledger(unit.id)).toEqual([{ refund_id: mine, minor: 200 }]);
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 200 });
    await invariantsHold();
  });

  it.each([
    ['upper', (s: string) => s.toUpperCase()],
    ['padded', (s: string) => `  ${s}\n`],
    ['padded and lower', (s: string) => ` ${s.toLowerCase()} `],
  ])('a dashboard refund booked once is not booked again when listed %s', async (_n, vary) => {
    const { a, unit } = await setup();
    const id = w.dashboard(unit.capture_id, 150);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: id, minor: 150 }]);
    await listOnly([{ refund_id: vary(id), status: 'COMPLETED', amount: usd(150) }]);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: id, minor: 150 }]);
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 150 });
  });

  it('the id is stored as listed, not normalised', async () => {
    const { a, unit } = await setup();
    await listOnly([{ refund_id: 'RFMixedCase1', status: 'COMPLETED', amount: usd(100) }]);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: 'RFMixedCase1', minor: 100 }]);
  });

  it('one id listed twice that differs only by case is one refund; with two amounts it freezes', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFCaseTwin', status: 'COMPLETED', amount: usd(100) },
      { refund_id: 'rfcasetwin', status: 'COMPLETED', amount: usd(100) },
    ]);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: 'RFCaseTwin', minor: 100 }]);
    await listOnly([
      { refund_id: 'RFOther', status: 'COMPLETED', amount: usd(100) },
      { refund_id: ' rfother', status: 'COMPLETED', amount: usd(120) },
    ]);
    await reread(a.order_id);
    expect((await alertRows(a.order_id)).map((x) => x.detail.reason)).toContain(
      'refund_list_conflict_RFOther',
    );
  });

  it('two ids that really differ are not merged', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RF1', status: 'COMPLETED', amount: usd(100) },
      { refund_id: 'RF2', status: 'COMPLETED', amount: usd(100) },
    ]);
    await reread(a.order_id);
    expect((await ledger(unit.id)).map((x) => x.refund_id)).toEqual(['RF1', 'RF2']);
  });
});

describe('LOW-3: a request that was never executed can be cancelled', () => {
  const cancel = (id: string, actor: Parameters<typeof cancelRefundRequest>[2] = OPERATOR) =>
    cancelRefundRequest(w.deps, id, actor);

  it('cancels a requested request: cancelled, audited, reservation freed, the unit is open again', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    expect(await cancel(rq)).toEqual({ ok: true, value: { refund_request_id: rq } });
    expect((await reqRow(rq)).state).toBe('cancelled');
    const audit = w.audits.filter((x) => x.action === 'refund.cancelled');
    expect(audit).toEqual([expect.objectContaining({ actor: OPERATOR, target: rq })]);
    // The whole amount can be requested again.
    expect(await request(unit.id, 500)).toBeTruthy();
    await invariantsHold();
  });

  it('works with refunds switched off (the reason it exists)', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    w.switches.refunds_enabled = false;
    expect(await run(rq)).toEqual({ ok: false, error: { code: 'rejected' } });
    expect((await cancel(rq)).ok).toBe(true);
    expect((await reqRow(rq)).state).toBe('cancelled');
  });

  it('is refused for a buyer, a system actor, and an operator without MFA; nothing changes', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    expect(await cancel(rq, { kind: 'buyer', buyer_id: 'buy_A' })).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await cancel(rq, { kind: 'system' })).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await cancel(rq, { kind: 'operator', operator_id: 'opr_1', mfa: false })).toEqual({
      ok: false,
      error: { code: 'mfa_required' },
    });
    expect((await reqRow(rq)).state).toBe('requested');
    expect(w.audits.filter((x) => x.action === 'refund.cancelled')).toEqual([]);
  });

  it.each([
    'sent',
    'unknown',
    'pending',
    'completed',
    'failed',
    'rejected',
    'unresolved',
    'cancelled',
  ])('a %s request cannot be cancelled', async (state) => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    await w.rows('UPDATE refund_requests SET state = $2 WHERE id = $1', [rq, state]);
    expect(await cancel(rq)).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect((await reqRow(rq)).state).toBe(state);
  });

  it('a request that has a refund id cannot be cancelled even if it says requested', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    await w.rows("UPDATE refund_requests SET refund_id = 'RFX' WHERE id = $1", [rq]);
    expect(await cancel(rq)).toEqual({ ok: false, error: { code: 'wrong_state' } });
  });

  it('unknown and malformed ids are not_found', async () => {
    await setup();
    for (const id of ['rfr_unknown', '', "x'; DROP TABLE refund_requests; --"]) {
      expect(await cancel(id)).toEqual({ ok: false, error: { code: 'not_found' } });
    }
  });

  it('cancelling twice: the second says wrong_state and audits nothing new', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    await cancel(rq);
    expect(await cancel(rq)).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect(w.audits.filter((x) => x.action === 'refund.cancelled')).toHaveLength(1);
  });

  it('a put-off request (its send waits for a read) is cancelled with its operation: the due pass never sends it', async () => {
    const { a, unit } = await setup();
    const rq = await request(unit.id, 300);
    w.script({ kind: 'unavailable', retry_after_ms: null });
    await run(rq);
    expect((await reqRow(rq)).state).toBe('requested');
    expect((await cancel(rq)).ok).toBe(true);
    const ops = await w.rows<{ state: string; failure_reason: string | null }>(
      "SELECT state, failure_reason FROM operations WHERE order_id = $1 AND kind = 'refund'",
      [a.order_id],
    );
    expect(ops).toEqual([{ state: 'failed', failure_reason: 'invalid_request' }]);
    w.tick(60 * SEC);
    await runDue(w.deps, { max_items: 10 });
    expect(w.sends()).toHaveLength(0);
    expect((await reqRow(rq)).state).toBe('cancelled');
    expect(await alertKinds(w, a.order_id)).toEqual([]);
  });

  it('a cancel racing an execute: the request is either sent once or cancelled and never sent', async () => {
    for (let k = 0; k < 4; k += 1) {
      const { unit } = await setup();
      const rq = await request(unit.id, 300);
      const [c, e] = await Promise.all([cancel(rq), run(rq)]);
      const state = (await reqRow(rq)).state;
      if (c.ok) {
        expect(state).toBe('cancelled');
        expect(w.sends()).toHaveLength(0);
        expect(e.ok && e.value.status).toBe('CANCELLED');
      } else {
        expect(c.error.code).toBe('wrong_state');
        expect(w.sends()).toHaveLength(1);
        expect(state).toBe('completed');
      }
      await invariantsHold();
      await w.close();
    }
    await setup();
  });

  it('executing a cancelled request sends nothing', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 300);
    await cancel(rq);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'CANCELLED' } });
    expect(w.sends()).toHaveLength(0);
    expect(w.reads()).toBe(0);
  });
});

describe('LOW-5: the local remaining comes from the ledger', () => {
  it('a stale refunded_minor column does not let a request exceed what the ledger leaves', async () => {
    const { unit } = await setup();
    await run(await request(unit.id, 200));
    await w.rows('UPDATE order_units SET refunded_minor = 0 WHERE id = $1', [unit.id]);
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(400),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'over_refund' } });
    expect(
      (
        await requestRefund(w.deps, {
          unit_id: unit.id,
          amount: usd(300),
          reason: 'x',
          actor: OPERATOR,
        })
      ).ok,
    ).toBe(true);
  });
});
