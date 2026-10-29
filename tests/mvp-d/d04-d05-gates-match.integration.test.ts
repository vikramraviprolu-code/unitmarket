// MVP-D offline acceptance D-04 and D-05 (mvp-plan MVP-D table; nfr.md P18 and P5 per unit).
// D-04: a publisher without a verified payee never reaches an approval, and one that loses its
// verification between the approval and the order never reaches PayPal. D-05: a unit that does not
// match its PayPal read-back after the capture puts that PayPal order on hold ("frozen_order", never
// "not charged"); a mismatch found in the pre-capture pass freezes the whole order with zero captures.
// Real routes and engine over the approved sandbox transport and a fake Wire playing the dry-run model;
// no byte leaves the process. Banner tone classes are not asserted (DP-5b).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@umsbx/payments';
import {
  CONSENT,
  HARBOUR_TIDE,
  QUAY_MARKET,
  bootDRig,
  fingerprint,
  orderStatus,
  poStates,
  postApproval,
  postOrder,
  proposalFor,
  runPack,
} from './d-support';
import type { DRig } from './d-support';

vi.mock('server-only', () => ({}));

let rig: DRig;
afterEach(async () => {
  await rig?.close();
});

const failing = async (): Promise<string[]> =>
  (await checkInvariants(rig.app.db)).filter((i) => !i.ok).map((i) => `${i.id}: ${i.detail}`);
const NOT_CHARGED = /not charged|were not charged|was not charged/i;

describe('D-04 unverified_payee_refused', () => {
  beforeEach(async () => {
    rig = await bootDRig();
  }, 60_000);

  it.each([
    ['quayside-gazette', QUAY_MARKET],
    ['harbour-ledger', HARBOUR_TIDE],
  ] as const)(
    'D-04 no snapshot is made for a pack when %s has no payee_verified_at: 409, no approval, no order, no PayPal call',
    async (slug) => {
      await rig.rows('UPDATE publishers SET payee_verified_at = NULL WHERE slug = $1', [slug]);
      const before = await fingerprint(rig);
      const res = await postApproval(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET]);
      expect(res.status).toBe(409);
      expect((res.body['error'] as { code: string }).code).toBe('publisher_unverified');
      expect(await rig.count('SELECT count(*) AS c FROM approvals')).toBe(0);
      expect(await rig.count('SELECT count(*) AS c FROM orders')).toBe(0);
      expect(rig.played).toEqual([]);
      // Only the quotes and the proposal the buyer's own browsing made exist; nothing money-shaped.
      const after = await fingerprint(rig);
      for (const t of [
        'orders',
        'order_units',
        'provider_orders',
        'ledger_entries',
        'approvals',
      ] as const)
        expect(after[t], t).toBe(before[t]);
    },
  );

  it('D-04 the same pack is approved once both publishers are verified (the refusal is the missing payee, nothing else)', async () => {
    await rig.rows('UPDATE publishers SET payee_verified_at = NULL WHERE slug = $1', [
      'quayside-gazette',
    ]);
    expect((await postApproval(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET])).status).toBe(409);
    await rig.rows('UPDATE publishers SET payee_verified_at = now() WHERE slug = $1', [
      'quayside-gazette',
    ]);
    const ok = await postApproval(rig, 'B', [HARBOUR_TIDE, QUAY_MARKET]);
    expect(ok.status).toBe(201);
  });

  it('D-04 a payee lost between the approval and the order: 409 payee_unavailable, no order, no unit, no PayPal order, no call', async () => {
    const p = await proposalFor(rig.app, rig.B, [HARBOUR_TIDE, QUAY_MARKET]);
    const g = await rig.app.engine.requestApproval({
      actor: rig.B,
      selection: { kind: 'proposal', proposal_id: p.proposal_id, offer_ids: p.offer_ids },
      consent: CONSENT,
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    await rig.rows('UPDATE publishers SET payee_verified_at = NULL WHERE slug = $1', [
      'quayside-gazette',
    ]);
    const res = await postOrder(rig, 'B', g.value);
    expect(res.status).toBe(409);
    expect((res.body['error'] as { code: string }).code).toBe('payee_unavailable');
    expect(await rig.count('SELECT count(*) AS c FROM orders')).toBe(0);
    expect(await rig.count('SELECT count(*) AS c FROM order_units')).toBe(0);
    expect(await rig.count('SELECT count(*) AS c FROM provider_orders')).toBe(0);
    expect(await rig.count('SELECT count(*) AS c FROM entitlements')).toBe(0);
    expect(rig.played).toEqual([]);
  });
});

describe('D-05 per_unit_match', () => {
  beforeEach(async () => {
    // after the 2nd capture, the read of that PayPal order shows another payee or amount than we expect
    rig = await bootDRig({ wire: { after_capture: { 2: 'mismatch_payee' } } });
  }, 60_000);

  it('D-05 a payee mismatch after a capture holds that PayPal order: the unit is "mismatch", the order is flagged, a frozen_order alert, never "not charged"', async () => {
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'happy']);
    expect(await orderStatus(rig, run.order_id)).toBe('paid_partial');
    const states = await poStates(rig, run.order_id);
    expect(states).toEqual(['captured', 'frozen']);
    // Both captures were sent; the mismatch was found in the read-back, after the money moved.
    expect(rig.calls('capture_order')).toBe(2);
    expect(await rig.count('SELECT count(*) AS c FROM orders WHERE mismatch')).toBe(1);

    const units = await rig.rows<{
      status: string;
      mismatch_reason: string | null;
      access: string;
      po_state: string;
    }>(
      `SELECT u.status, u.mismatch_reason, e.access_state AS access, p.state AS po_state
         FROM order_units u JOIN provider_orders p ON p.id = u.provider_order_ref
         JOIN entitlements e ON e.unit_id = u.id WHERE u.order_id = $1 ORDER BY p.position`,
      [run.order_id],
    );
    expect(units[0]).toMatchObject({ status: 'captured_verified', access: 'available' });
    expect(units[1]).toMatchObject({
      status: 'mismatch',
      mismatch_reason: 'payee',
      access: 'locked',
    });

    const alerts = await rig.rows<{ kind: string; detail: { field?: string } }>(
      'SELECT kind, detail FROM alerts ORDER BY kind',
    );
    expect(alerts.map((a) => a.kind)).toEqual(['frozen_order']);
    expect(alerts[0]!.detail.field).toBe('payee');

    // On hold is not "not charged": no line and no message says so for the held item.
    const v = await rig.app.engine.orderView({ order_ref: run.order_ref, actor: rig.A });
    const kinds = (v?.items ?? []).map((i) => i.kind).sort();
    expect(kinds).toEqual(['hold', 'ready']);
    expect(v?.buyer_message ?? '').not.toMatch(NOT_CHARGED);
    for (const i of v?.items ?? [])
      if (i.kind === 'hold') expect(i.line ?? '').not.toMatch(NOT_CHARGED);

    // The books hold only the verified unit's sale (INV7 holds per publisher).
    expect(await rig.count(`SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'`)).toBe(1);
    expect(await failing()).toEqual([]);
    // No partial_composite for a hold: only a PayPal order that is not charged raises it.
    expect(
      await rig.count(`SELECT count(*) AS c FROM alerts WHERE kind = 'partial_composite'`),
    ).toBe(0);
  });
});

describe('D-05 per_unit_match, amount and pre-capture pass', () => {
  it('D-05 an amount mismatch after a capture holds that PayPal order the same way', async () => {
    rig = await bootDRig({ wire: { after_capture: { 1: 'mismatch_amount' } } });
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'happy']);
    expect(await orderStatus(rig, run.order_id)).toBe('paid_partial');
    expect(await poStates(rig, run.order_id)).toEqual(['frozen', 'captured']);
    const bad = await rig.rows<{ status: string; mismatch_reason: string }>(
      `SELECT u.status, u.mismatch_reason FROM order_units u
         JOIN provider_orders p ON p.id = u.provider_order_ref WHERE p.position = 1`,
    );
    expect(bad).toEqual([{ status: 'mismatch', mismatch_reason: 'amount' }]);
    const v = await rig.app.engine.orderView({ order_ref: run.order_ref, actor: rig.A });
    expect((v?.items ?? []).map((i) => i.kind).sort()).toEqual(['hold', 'ready']);
    expect(v?.buyer_message ?? '').not.toMatch(NOT_CHARGED);
    expect(await failing()).toEqual([]);
  });

  it.each([
    ['payee, second PayPal order', ['happy', 'mismatch_payee']],
    ['amount, second PayPal order', ['happy', 'mismatch_amount']],
    ['payee, first PayPal order', ['mismatch_payee', 'happy']],
  ] as const)(
    'D-05 a mismatch (%s) in the pre-capture pass freezes the whole order with zero captures: no capture sent, no sale, nothing available, never "not charged"',
    async (_name, scenarios) => {
      rig = await bootDRig();
      const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], [...scenarios]);
      const last = run.returns[1]!;
      expect(last.ok).toBe(false);
      expect(!last.ok && last.error.code).toBe('frozen');
      expect(await orderStatus(rig, run.order_id)).toBe('frozen');
      expect(await poStates(rig, run.order_id)).toEqual(['frozen', 'frozen']);
      expect(rig.calls('capture_order')).toBe(0);
      expect(
        await rig.count('SELECT count(*) AS c FROM order_units WHERE capture_id IS NOT NULL'),
      ).toBe(0);
      expect(await rig.count('SELECT count(*) AS c FROM ledger_entries')).toBe(0);
      expect(
        await rig.count(`SELECT count(*) AS c FROM entitlements WHERE access_state <> 'locked'`),
      ).toBe(0);
      expect(await rig.count('SELECT count(*) AS c FROM orders WHERE mismatch')).toBe(1);
      const alerts = await rig.rows<{ kind: string; detail: { phase?: string } }>(
        'SELECT kind, detail FROM alerts',
      );
      expect(alerts.map((a) => a.kind)).toEqual(['frozen_order']);
      expect(alerts[0]!.detail.phase).toBe('pre_capture');
      const v = await rig.app.engine.orderView({ order_ref: run.order_ref, actor: rig.A });
      expect((v?.items ?? []).every((i) => i.kind === 'hold')).toBe(true);
      expect(
        [v?.buyer_message ?? '', ...(v?.items ?? []).map((i) => i.line ?? '')].join('\n'),
      ).not.toMatch(NOT_CHARGED);
      expect(await failing()).toEqual([]);
    },
  );

  it('D-05 a frozen pack stays frozen: another return and a job pass capture nothing', async () => {
    rig = await bootDRig();
    const run = await runPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET], ['happy', 'mismatch_payee']);
    expect(await orderStatus(rig, run.order_id)).toBe('frozen');
    const jobs = await rig.app.startJobs();
    await new Promise((r) => setTimeout(r, 1200));
    await jobs.stop();
    await rig.app.engine.payments.onBuyerReturn({
      order_ref: run.order_ref,
      actor: rig.A,
      scenario: null,
    });
    expect(await orderStatus(rig, run.order_id)).toBe('frozen');
    expect(rig.calls('capture_order')).toBe(0);
  });
});
