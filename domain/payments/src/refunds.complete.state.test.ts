// CO-4 state tests (ASM-53, ASM-59, ASM-61, D-019, D-020; nfr P9, P11, M3, C-06, C-07).
// Refunds complete: an operator needs MFA; one open request per unit; a refund made at the PayPal
// dashboard is booked from the order's refund list (never from refunded_minor alone, never before a
// read shows it); the unit status follows the ledger sums; a pending refund moves no money event;
// "refund the rest" is clamped to what PayPal still holds. Real PGlite, scripted PayPal that lists
// the refunds it holds (remaining-world.ts). Synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { issueLink } from '@umsbx/delivery';
import { getReceiptForBuyer } from '@umsbx/receipts';
import { checkInvariants, executeRefund, reconcileOrder, requestRefund, runDue } from './index';
import { BUYER_A, OPERATOR, alertKinds, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const SEC = 1_000;
const usd = (minor: number) => ({ currency: 'USD', minor });
const NO_MFA = { kind: 'operator', operator_id: 'opr_1', mfa: false } as const;

/** INV1 to INV4 hold (INV1 is checked per unit: sale minus refunds equals captured minus refunded). */
async function invariantsHold(): Promise<void> {
  const r = await checkInvariants(w.db);
  expect(r.filter((x) => ['INV1', 'INV2', 'INV3', 'INV4'].includes(x.id))).toEqual(
    ['INV1', 'INV2', 'INV3', 'INV4'].map((id) => expect.objectContaining({ id, ok: true })),
  );
}
/** A state test that always ends with the invariants (item f). */
function check(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    await fn();
    await invariantsHold();
  });
}

async function setup(price = 500, o: Parameters<typeof paid>[1] = {}) {
  w = await makeRemainingWorld({ price });
  const a = await paid(w, o);
  w.markReads();
  const units = await w.rows<{ id: string; capture_id: string; amount_minor: number }>(
    'SELECT id, capture_id, amount_minor FROM order_units WHERE order_id = $1',
    [a.order_id],
  );
  return { a, unit: units[0]! };
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
    await w.rows<{ state: string; amount_minor: number; refund_id: string | null }>(
      'SELECT state, amount_minor, refund_id FROM refund_requests WHERE id = $1',
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
const ents = (unit_id: string) =>
  w.rows<{ money_state: string; access_state: string; licence_state: string | null }>(
    'SELECT money_state, access_state, licence_state FROM entitlements WHERE unit_id = $1 ORDER BY article_id',
    [unit_id],
  );
const ledger = async (unit_id: string) =>
  (
    await w.rows<{ refund_id: string; amount_minor: number }>(
      "SELECT refund_id, amount_minor FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund' ORDER BY refund_id",
      [unit_id],
    )
  ).map((x) => ({ refund_id: x.refund_id, minor: Number(x.amount_minor) }));
const versions = async (order_id: string) =>
  (
    await w.rows<{ version: number }>(
      'SELECT version FROM receipts WHERE order_id = $1 ORDER BY version',
      [order_id],
    )
  ).map((x) => Number(x.version));
const alertRows = (order_id: string) =>
  w.rows<{ kind: string; detail: { reason: string } & Record<string, unknown> }>(
    'SELECT kind, detail FROM alerts WHERE order_id = $1 ORDER BY kind, id',
    [order_id],
  );
const reread = (order_id: string) => reconcileOrder(w.deps, { order_id, trigger: 'poll' });
const transitionLogs = (unit_id: string) =>
  w.rows<{ transition_log: unknown }>(
    'SELECT transition_log FROM entitlements WHERE unit_id = $1 ORDER BY article_id',
    [unit_id],
  );

describe('goal 1: the operator needs MFA (P9)', () => {
  check('operator without MFA: mfa_required, nothing stored', async () => {
    const { unit } = await setup();
    const before = w.audits.length;
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(200),
      reason: 'x',
      actor: NO_MFA,
    });
    expect(r).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
    expect(
      await w.rows("SELECT 1 FROM operations WHERE kind IN ('refund', 'refund_readback')"),
    ).toEqual([]);
    expect(w.audits.length).toBe(before);
    expect(w.paypal.calls.filter((c) => c.op === 'get')).toHaveLength(0); // no read for a refused caller
  });

  check(
    'MFA is checked before the switch: a refused caller learns nothing about the switch',
    async () => {
      const { unit } = await setup();
      w.switches.refunds_enabled = false;
      const r = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(200),
        reason: 'x',
        actor: NO_MFA,
      });
      expect(r).toEqual({ ok: false, error: { code: 'mfa_required' } });
      const withMfa = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(200),
        reason: 'x',
        actor: OPERATOR,
      });
      expect(withMfa).toEqual({ ok: false, error: { code: 'refunds_off' } });
    },
  );

  check('a buyer and the system are not operators, MFA or not', async () => {
    const { unit } = await setup();
    for (const actor of [BUYER_A, { kind: 'system' } as const]) {
      expect(
        await requestRefund(w.deps, { unit_id: unit.id, amount: usd(200), reason: 'x', actor }),
      ).toEqual({ ok: false, error: { code: 'not_operator' } });
    }
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
  });

  check('an operator with MFA still gets a request row and an audit entry', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, 200);
    expect((await reqRow(rq)).state).toBe('requested');
    expect(w.audits.filter((x) => x.action === 'refund.requested')).toHaveLength(1);
  });
});

describe('goal 2: one open request per unit', () => {
  it.each(['requested', 'sent', 'unknown', 'pending'] as const)(
    'second request while one is %s: refund_in_flight',
    async (state) => {
      const { unit } = await setup();
      const rq = await request(unit.id, 200);
      await w.rows('UPDATE refund_requests SET state = $2 WHERE id = $1', [rq, state]);
      const second = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(100),
        reason: 'x',
        actor: OPERATOR,
      });
      expect(second).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
      expect(await w.rows('SELECT 1 FROM refund_requests')).toHaveLength(1);
      await invariantsHold();
    },
  );

  it.each(['completed', 'failed', 'cancelled', 'rejected'] as const)(
    'a %s request does not block the next one',
    async (state) => {
      const { unit } = await setup();
      const rq = await request(unit.id, 200);
      await w.rows('UPDATE refund_requests SET state = $2 WHERE id = $1', [rq, state]);
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
    },
  );

  check('second request while one is open: refund_in_flight (double click)', async () => {
    const { unit } = await setup();
    await request(unit.id, 200);
    const again = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(200),
      reason: 'x',
      actor: OPERATOR,
    });
    expect(again).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toHaveLength(1);
  });

  check('another unit of another order is not blocked', async () => {
    const { unit } = await setup();
    await request(unit.id, 200);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_3'] });
    const other = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [b.order_id])
    )[0]!;
    expect(
      (
        await requestRefund(w.deps, {
          unit_id: other.id,
          amount: usd(100),
          reason: 'x',
          actor: OPERATOR,
        })
      ).ok,
    ).toBe(true);
  });

  check(
    'in flight is checked before the amount: an over-asking second request says refund_in_flight',
    async () => {
      const { unit } = await setup();
      await request(unit.id, 200);
      const r = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(9_999),
        reason: 'x',
        actor: OPERATOR,
      });
      expect(r).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
    },
  );
});

describe('C-06: partial then remainder', () => {
  check(
    'partial 2.00 then remainder: two refund rows, two ledger entries keyed by refund id, unit partially_refunded then refunded, access revoked after the second',
    async () => {
      const { a, unit } = await setup();
      const first = await request(unit.id, 200);
      expect(await run(first)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
      const r1 = await reqRow(first);
      expect(r1.state).toBe('completed');
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 200 });
      expect(await ledger(unit.id)).toEqual([{ refund_id: r1.refund_id, minor: 200 }]);
      // Access continues after a partial refund (ASM-59).
      expect(await ents(unit.id)).toEqual([
        { money_state: 'captured', access_state: 'available', licence_state: 'granted' },
      ]);
      expect(await versions(a.order_id)).toEqual([1, 2]);

      const second = await request(unit.id, null); // the rest
      expect((await reqRow(second)).amount_minor).toBe(300);
      expect(await run(second)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
      const r2 = await reqRow(second);
      expect(r2.refund_id).not.toBe(r1.refund_id);

      expect(await w.rows('SELECT 1 FROM refund_requests')).toHaveLength(2);
      expect(await ledger(unit.id)).toEqual(
        [
          { refund_id: r1.refund_id, minor: 200 },
          { refund_id: r2.refund_id, minor: 300 },
        ].sort((x, y) => (x.refund_id! < y.refund_id! ? -1 : 1)),
      );
      expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
      expect(await ents(unit.id)).toEqual([
        { money_state: 'refunded', access_state: 'revoked', licence_state: 'terminated' },
      ]);
      expect(await versions(a.order_id)).toEqual([1, 2, 3]);
      expect(w.sends().map((s) => s.amount)).toEqual([usd(200), usd(300)]);
    },
  );

  check(
    'the unit is not refunded until the sums say so: 4.99 of 5.00 stays partially_refunded with access',
    async () => {
      const { unit } = await setup();
      expect((await run(await request(unit.id, 499))).ok).toBe(true);
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 499 });
      expect((await ents(unit.id))[0]).toMatchObject({
        money_state: 'captured',
        access_state: 'available',
      });
      expect((await run(await request(unit.id, 1))).ok).toBe(true);
      expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
      expect((await ents(unit.id))[0]).toMatchObject({
        money_state: 'refunded',
        access_state: 'revoked',
      });
    },
  );

  check(
    'three partial refunds in a row, each its own request, entry and receipt version',
    async () => {
      const { a, unit } = await setup();
      for (const minor of [100, 150, 50]) {
        expect((await run(await request(unit.id, minor))).ok).toBe(true);
      }
      expect((await ledger(unit.id)).map((x) => x.minor).sort()).toEqual([100, 150, 50].sort());
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 300 });
      expect(await versions(a.order_id)).toEqual([1, 2, 3, 4]);
    },
  );
});

describe('C-07: full refund', () => {
  check(
    'full refund: online item revoked, keep item links stop, receipt shows the refund',
    async () => {
      // One order per option: the keep item (4.00) and the online item (2.50).
      w = await makeRemainingWorld({ price: 400 });
      const keep = await paid(w, { offers: ['ofr_1'] });
      const online = await paid(w, { offers: ['ofr_2'], option: 'online_read' });
      const unitOf = async (order_id: string) =>
        (
          await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [order_id])
        )[0]!.id;
      const entOf = async (unit_id: string) =>
        (
          await w.rows<{ id: string }>('SELECT id FROM entitlements WHERE unit_id = $1', [unit_id])
        )[0]!.id;
      const keepUnit = await unitOf(keep.order_id);
      const onlineUnit = await unitOf(online.order_id);
      const keepEnt = await entOf(keepUnit);
      const linkBefore = await issueLink(w.deps as never, {
        entitlement_id: keepEnt,
        actor: BUYER_A,
      });
      expect(linkBefore.ok).toBe(true);

      for (const unit_id of [keepUnit, onlineUnit]) {
        expect(await run(await request(unit_id, null))).toEqual({
          ok: true,
          value: { status: 'COMPLETED' },
        });
        expect((await unitRow(unit_id)).status).toBe('refunded');
        expect(await ents(unit_id)).toEqual([
          { money_state: 'refunded', access_state: 'revoked', licence_state: 'terminated' },
        ]);
      }
      // Links stop.
      const linkAfter = await issueLink(w.deps as never, {
        entitlement_id: keepEnt,
        actor: BUYER_A,
      });
      expect(linkAfter).toEqual({
        ok: false,
        error: { code: 'not_available', access: 'revoked', money: 'refunded' },
      });
      // The receipt shows the refund.
      for (const [o, minor] of [
        [keep, 400],
        [online, 250],
      ] as const) {
        const receipt = (await getReceiptForBuyer(w.db, {
          order_id: o.order_id,
          buyer_id: 'buy_A',
        }))!;
        expect(receipt.version).toBe(2);
        expect(receipt.refunds).toEqual([
          { refund_id: expect.any(String), amount: usd(minor), at: expect.any(String) },
        ]);
      }
    },
  );

  check('a full refund through two dashboard refunds ends access exactly once', async () => {
    const { a, unit } = await setup();
    const d1 = w.dashboard(unit.capture_id, 200);
    await reread(a.order_id);
    expect((await ents(unit.id))[0]).toMatchObject({
      money_state: 'captured',
      access_state: 'available',
    });
    const d2 = w.dashboard(unit.capture_id, 300);
    await reread(a.order_id);
    expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
    expect((await ents(unit.id))[0]).toMatchObject({
      money_state: 'refunded',
      access_state: 'revoked',
    });
    expect((await ledger(unit.id)).map((x) => x.refund_id).sort()).toEqual([d1, d2].sort());
    expect(await versions(a.order_id)).toEqual([1, 2, 3]);
    await reread(a.order_id);
    expect(await versions(a.order_id)).toEqual([1, 2, 3]);
  });
});

describe('goal 3: refunds made at the PayPal dashboard are booked from the order refund list (ASM-53)', () => {
  check(
    'dashboard refund 1.50 seen on a re-read: one ledger entry with that refund id, receipt version 2, no refund_unbooked alert',
    async () => {
      const { a, unit } = await setup();
      const id = w.dashboard(unit.capture_id, 150);
      // Nothing is booked before a read shows it.
      expect(await ledger(unit.id)).toEqual([]);
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([{ refund_id: id, minor: 150 }]);
      expect(await versions(a.order_id)).toEqual([1, 2]);
      expect(await alertKinds(w, a.order_id)).toEqual([]);
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 150 });
      // Access continues (ASM-59) and no money event was sent for a partial refund (ASM-61).
      expect(await ents(unit.id)).toEqual([
        { money_state: 'captured', access_state: 'available', licence_state: 'granted' },
      ]);
      const receipt = (await getReceiptForBuyer(w.db, {
        order_id: a.order_id,
        buyer_id: 'buy_A',
      }))!;
      expect(receipt.version).toBe(2);
      expect(receipt.refunds).toEqual([
        { refund_id: id, amount: usd(150), at: expect.any(String) },
      ]);
      // The ledger row is a full ledger refund entry tied to the sale.
      const row = (
        await w.rows<{
          currency: string;
          ref_entry_id: string | null;
          capture_id: string;
          environment: string;
        }>(
          "SELECT currency, ref_entry_id, capture_id, environment FROM ledger_entries WHERE kind = 'refund'",
        )
      )[0]!;
      expect(row).toMatchObject({
        currency: 'USD',
        capture_id: unit.capture_id,
        environment: 'dryrun',
      });
      const sale = (
        await w.rows<{ id: string }>("SELECT id FROM ledger_entries WHERE kind = 'sale'")
      )[0]!;
      expect(row.ref_entry_id).toBe(sale.id);
    },
  );

  check('the same dashboard refund seen twice: one entry', async () => {
    const { a, unit } = await setup();
    const id = w.dashboard(unit.capture_id, 150);
    await reread(a.order_id);
    await reread(a.order_id);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: id, minor: 150 }]);
    expect(await versions(a.order_id)).toEqual([1, 2]);
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 150 });
  });

  check('two dashboard refunds in one read: two entries, one new receipt version', async () => {
    const { a, unit } = await setup();
    const d1 = w.dashboard(unit.capture_id, 100);
    const d2 = w.dashboard(unit.capture_id, 150);
    await reread(a.order_id);
    expect((await ledger(unit.id)).map((x) => x.refund_id)).toEqual([d1, d2].sort());
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 250 });
    expect(await versions(a.order_id)).toEqual([1, 2]);
  });

  check(
    'a refund of UnitMarket (matched by refund id) is left to the read-back: no second entry',
    async () => {
      const { a, unit } = await setup();
      const rq = await request(unit.id, 200);
      await run(rq);
      const mine = (await reqRow(rq)).refund_id!;
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([{ refund_id: mine, minor: 200 }]);
      expect(await versions(a.order_id)).toEqual([1, 2]);
    },
  );

  check(
    'a dashboard refund beside a refund of UnitMarket: each booked once, sums are the status',
    async () => {
      const { a, unit } = await setup();
      await run(await request(unit.id, 200));
      const dash = w.dashboard(unit.capture_id, 300);
      await reread(a.order_id);
      expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
      expect((await ledger(unit.id)).map((x) => x.minor).sort()).toEqual([200, 300]);
      expect((await ledger(unit.id)).map((x) => x.refund_id)).toContain(dash);
      expect((await ents(unit.id))[0]).toMatchObject({ access_state: 'revoked' });
    },
  );

  check('list unavailable: the refund_unbooked alert stays and nothing is booked', async () => {
    const { a, unit } = await setup();
    w.dashboard(unit.capture_id, 150);
    const provider = (
      await w.rows<{ provider_order_id: string }>('SELECT provider_order_id FROM provider_orders')
    )[0]!.provider_order_id;
    await w.editNextRead(provider, (r) => ({
      ...r,
      units: r.units.map((u) => ({
        reference_id: u.reference_id,
        payee_merchant_id: u.payee_merchant_id,
        amount: u.amount,
        capture: u.capture,
      })), // no `refunds` key: the list is unavailable
    }));
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([]);
    expect((await alertRows(a.order_id)).map((x) => x.kind)).toEqual(['refund_unbooked']);
    expect(await versions(a.order_id)).toEqual([1]);
  });

  check(
    'an empty list beside a capture that reads refunded is "unavailable" too: alert, nothing booked',
    async () => {
      const { a, unit } = await setup();
      w.dashboard(unit.capture_id, 150);
      const provider = (
        await w.rows<{ provider_order_id: string }>('SELECT provider_order_id FROM provider_orders')
      )[0]!.provider_order_id;
      await w.editNextRead(provider, (r) => ({
        ...r,
        units: r.units.map((u) => ({ ...u, refunds: [] })),
      }));
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([]);
      expect((await alertRows(a.order_id)).map((x) => x.kind)).toEqual(['refund_unbooked']);
    },
  );

  check(
    'a pending, failed or cancelled dashboard refund books nothing and sends no money event; the completed one does',
    async () => {
      const { a, unit } = await setup();
      const pend = w.dashboard(unit.capture_id, 150, 'PENDING');
      w.dashboard(unit.capture_id, 100, 'FAILED');
      w.dashboard(unit.capture_id, 100, 'CANCELLED');
      const logs = await transitionLogs(unit.id);
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([]);
      expect(await unitRow(unit.id)).toEqual({ status: 'captured_verified', refunded_minor: 0 });
      expect(await versions(a.order_id)).toEqual([1]);
      expect(await alertKinds(w, a.order_id)).toEqual([]);
      expect(await transitionLogs(unit.id)).toEqual(logs);
      // PayPal completes it: the next read books it.
      w.refunds.get(pend)!.status = 'COMPLETED';
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([{ refund_id: pend, minor: 150 }]);
    },
  );

  check(
    'a dashboard refund while a request of ours waits as pending: ours is left to its read-back, the dashboard one is booked',
    async () => {
      const { a, unit } = await setup();
      w.refundNext.status = 'PENDING';
      const rq = await request(unit.id, 200);
      expect(await run(rq)).toEqual({ ok: true, value: { status: 'PENDING' } });
      const mine = (await reqRow(rq)).refund_id!;
      const dash = w.dashboard(unit.capture_id, 100);
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([{ refund_id: dash, minor: 100 }]);
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 100 });
      // Ours completes; the read-back books it.
      w.refunds.get(mine)!.status = 'COMPLETED';
      w.tick(3_600 * SEC);
      await runDue(w.deps, { max_items: 10 });
      expect((await ledger(unit.id)).map((x) => x.minor).sort()).toEqual([100, 200]);
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 300 });
    },
  );

  check(
    'a refund of ours whose answer was lost is not booked as a dashboard refund; the resend finds its id and books it',
    async () => {
      const { a, unit } = await setup();
      w.refundNext.lose_response = true;
      const rq = await request(unit.id, 200);
      expect((await run(rq)).ok).toBe(false);
      w.refundNext.lose_response = false;
      expect((await reqRow(rq)).state).toBe('unknown');
      w.dashboard(unit.capture_id, 100);
      await reread(a.order_id);
      // The listed refunds may be ours: nothing is booked until the request is settled.
      expect(await ledger(unit.id)).toEqual([]);
      expect(await unitRow(unit.id)).toEqual({ status: 'captured_verified', refunded_minor: 0 });
      w.tick(31 * SEC);
      await runDue(w.deps, { max_items: 10 });
      expect((await reqRow(rq)).state).toBe('completed');
      await reread(a.order_id);
      expect((await ledger(unit.id)).map((x) => x.minor).sort()).toEqual([100, 200]);
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 300 });
    },
  );

  check(
    'a listed COMPLETED refund of a request our books closed as cancelled is a human matter: alert, nothing booked',
    async () => {
      const { a, unit } = await setup();
      w.refundNext.status = 'PENDING';
      const rq = await request(unit.id, 200);
      await run(rq);
      const mine = (await reqRow(rq)).refund_id!;
      // The books say ours was cancelled; PayPal now lists it as COMPLETED.
      await w.rows("UPDATE refund_requests SET state = 'cancelled' WHERE id = $1", [rq]);
      w.refunds.get(mine)!.status = 'COMPLETED';
      await reread(a.order_id);
      expect(await ledger(unit.id)).toEqual([]);
      const found = await alertRows(a.order_id);
      expect(found.map((x) => x.kind)).toEqual(['refund_unbooked']);
      expect(found[0]?.detail.reason).toBe(`listed_completed_after_cancelled_${mine}`);
    },
  );
});

describe('goal 4 and D-019: the status follows the sums, never refunded_minor alone', () => {
  check(
    'the sums decide even when refunded_minor is wrong: the column is repaired from the ledger',
    async () => {
      const { a, unit } = await setup();
      await run(await request(unit.id, 200));
      // A stale column (a hand edit, a restore): the ledger still says 2.00.
      await w.rows('UPDATE order_units SET refunded_minor = 0 WHERE id = $1', [unit.id]);
      w.dashboard(unit.capture_id, 300);
      await reread(a.order_id);
      expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
      expect((await ents(unit.id))[0]).toMatchObject({
        money_state: 'refunded',
        access_state: 'revoked',
      });
    },
  );

  check(
    'a stale column in the other direction does not turn a partial refund into a full one',
    async () => {
      const { a, unit } = await setup();
      await run(await request(unit.id, 200));
      await w.rows('UPDATE order_units SET refunded_minor = 450 WHERE id = $1', [unit.id]);
      w.dashboard(unit.capture_id, 100);
      await reread(a.order_id);
      expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 300 });
      expect((await ents(unit.id))[0]).toMatchObject({
        money_state: 'captured',
        access_state: 'available',
      });
    },
  );
});

describe('ASM-61 and the review notes: money events', () => {
  check('a partial refund equal to one item price in a two-item unit revokes nothing', async () => {
    w = await makeRemainingWorld({ price: 400 });
    const a = await paid(w, { offers: ['ofr_1', 'ofr_2'] });
    const unit = (
      await w.rows<{ id: string; capture_id: string }>(
        'SELECT id, capture_id FROM order_units WHERE order_id = $1',
        [a.order_id],
      )
    )[0]!;
    expect(await ents(unit.id)).toHaveLength(2);
    expect(await run(await request(unit.id, 400))).toEqual({
      ok: true,
      value: { status: 'COMPLETED' },
    });
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 400 });
    expect((await ents(unit.id)).map((e) => [e.money_state, e.access_state])).toEqual([
      ['captured', 'available'],
      ['captured', 'available'],
    ]);
    // The rest ends both.
    expect((await run(await request(unit.id, null))).ok).toBe(true);
    expect((await ents(unit.id)).map((e) => [e.money_state, e.access_state])).toEqual([
      ['refunded', 'revoked'],
      ['refunded', 'revoked'],
    ]);
  });

  check('a PayPal refund that reads PENDING is not booked and sends no money event', async () => {
    const { a, unit } = await setup();
    const logs = await transitionLogs(unit.id);
    const events = await w.rows('SELECT kind FROM access_events ORDER BY id');
    w.refundNext.status = 'PENDING';
    const rq = await request(unit.id, 200);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'PENDING' } });
    expect((await reqRow(rq)).state).toBe('pending');
    expect(await ledger(unit.id)).toEqual([]);
    expect(await unitRow(unit.id)).toEqual({ status: 'captured_verified', refunded_minor: 0 });
    expect(await transitionLogs(unit.id)).toEqual(logs);
    expect(await w.rows('SELECT kind FROM access_events ORDER BY id')).toEqual(events);
    expect(await versions(a.order_id)).toEqual([1]);
    // A full-amount pending refund neither revokes.
    await w.rows("UPDATE refund_requests SET state = 'failed' WHERE id = $1", [rq]);
    w.refundNext.status = 'PENDING';
    const full = await request(unit.id, 500);
    // PayPal already holds the 2.00 pending one, so the full amount is over what is left.
    expect(await run(full)).toEqual({ ok: true, value: { status: 'FAILED' } });
    expect((await ents(unit.id))[0]).toMatchObject({
      money_state: 'captured',
      access_state: 'available',
    });
  });

  check(
    'a pending refund that PayPal completes later books once and sends the event once',
    async () => {
      const { a, unit } = await setup();
      w.refundNext.status = 'PENDING';
      const rq = await request(unit.id, 500);
      expect((await run(rq)).ok).toBe(true);
      const id = (await reqRow(rq)).refund_id!;
      expect((await ents(unit.id))[0]).toMatchObject({ money_state: 'captured' });
      w.refunds.get(id)!.status = 'COMPLETED';
      w.tick(3_600 * SEC);
      await runDue(w.deps, { max_items: 10 });
      expect(await ledger(unit.id)).toEqual([{ refund_id: id, minor: 500 }]);
      expect((await ents(unit.id))[0]).toMatchObject({
        money_state: 'refunded',
        access_state: 'revoked',
      });
      expect(await versions(a.order_id)).toEqual([1, 2]);
    },
  );
});

describe('"refund the rest" is what PayPal still holds (BU-4 carry, review note)', () => {
  check('order 1: the dashboard refund is booked first, then the rest is asked: 2.00', async () => {
    const { a, unit } = await setup();
    const dash = w.dashboard(unit.capture_id, 300);
    await reread(a.order_id);
    expect(await ledger(unit.id)).toEqual([{ refund_id: dash, minor: 300 }]);
    const rq = await request(unit.id, null);
    expect((await reqRow(rq)).amount_minor).toBe(200);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(w.sends().map((s) => s.amount)).toEqual([usd(200)]);
    expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
  });

  check(
    'order 2: the rest is asked while the dashboard refund is not booked yet: still 2.00, and the dashboard refund is booked later',
    async () => {
      const { a, unit } = await setup();
      const dash = w.dashboard(unit.capture_id, 300); // PayPal holds it, UnitMarket has not read it
      const rq = await request(unit.id, null);
      expect((await reqRow(rq)).amount_minor).toBe(200);
      expect(await run(rq)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
      expect(w.sends().map((s) => s.amount)).toEqual([usd(200)]);
      await reread(a.order_id);
      const mine = (await reqRow(rq)).refund_id!;
      expect((await ledger(unit.id)).map((x) => x.refund_id).sort()).toEqual([dash, mine].sort());
      expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
      expect((await ents(unit.id))[0]).toMatchObject({ access_state: 'revoked' });
    },
  );

  check('the rest when PayPal holds nothing back is the whole local remaining', async () => {
    const { unit } = await setup();
    const rq = await request(unit.id, null);
    expect((await reqRow(rq)).amount_minor).toBe(500);
  });

  check(
    'the rest counts our own pending-or-unresolved refunds PayPal may not list yet',
    async () => {
      const { unit } = await setup();
      const first = await request(unit.id, 200);
      await w.rows("UPDATE refund_requests SET state = 'unresolved' WHERE id = $1", [first]);
      w.dashboard(unit.capture_id, 100);
      const rq = await request(unit.id, null);
      // local: 5.00 - 2.00 reserved = 3.00; PayPal: 5.00 - 1.00 listed - 2.00 of ours not listed = 2.00
      expect((await reqRow(rq)).amount_minor).toBe(200);
    },
  );

  check('the rest when PayPal holds nothing at all: over_refund, nothing stored', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 500);
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    expect(r).toEqual({ ok: false, error: { code: 'over_refund' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
  });

  check(
    'the rest when PayPal cannot be read: the local remaining, and the send check still protects',
    async () => {
      const { unit } = await setup();
      w.script({ kind: 'unavailable', retry_after_ms: null });
      const rq = await request(unit.id, null);
      expect((await reqRow(rq)).amount_minor).toBe(500);
      w.dashboard(unit.capture_id, 300);
      w.tick(61 * SEC);
      expect(await run(rq)).toEqual({ ok: true, value: { status: 'FAILED' } });
      expect(w.sends()).toHaveLength(0);
    },
  );

  check('an explicit amount is never trimmed: it is sent as asked or closed', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 300);
    const rq = await request(unit.id, 500);
    expect(await run(rq)).toEqual({ ok: true, value: { status: 'FAILED' } });
    expect(w.sends()).toHaveLength(0);
  });

  check('an explicit amount does not read PayPal at request time', async () => {
    const { unit } = await setup();
    await request(unit.id, 200);
    expect(w.reads()).toBe(0);
  });
});

describe('BU-4 send path: refunds in flight (items d and a)', () => {
  check(
    'an unresolved request IS subtracted by the in-flight rule (a mutant that drops it would send)',
    async () => {
      const { a, unit } = await setup();
      const unresolved = await request(unit.id, 200);
      await w.rows("UPDATE refund_requests SET state = 'unresolved' WHERE id = $1", [unresolved]);
      w.dashboard(unit.capture_id, 100); // PayPal: 4.00 left
      // local remaining 5.00 - 2.00 reserved = 3.00: the request is accepted
      const rq = await request(unit.id, 300);
      // PayPal 4.00 less our unresolved 2.00 (it may have landed, unlisted) = 2.00 < 3.00
      expect(await run(rq)).toEqual({ ok: true, value: { status: 'FAILED' } });
      expect(w.sends()).toHaveLength(0);
      const found = await alertRows(a.order_id);
      expect(found[0]?.detail).toMatchObject({ in_flight_minor: 200, remote_remaining_minor: 400 });
    },
  );

  check(
    'pinned: a lost-but-landed answer is subtracted twice (listed by PayPal and in flight), so one legitimate request may be closed (safe side)',
    async () => {
      const { a, unit } = await setup();
      // Ours was sent, the answer was lost, PayPal refunded 2.00 and lists it. The request has no id.
      w.refundNext.lose_response = true;
      const lost = await request(unit.id, 200);
      await run(lost);
      w.refundNext.lose_response = false;
      // The books settle it as unresolved (a human decides); the amount stays reserved.
      await w.rows("UPDATE refund_requests SET state = 'unresolved' WHERE id = $1", [lost]);
      const rq = await request(unit.id, 300); // local: 5.00 - 2.00 = 3.00
      // PayPal lists the 2.00 (remaining 3.00) AND the lost request is subtracted again: 1.00 < 3.00.
      expect(await run(rq)).toEqual({ ok: true, value: { status: 'FAILED' } });
      expect(w.sends()).toHaveLength(1); // only the lost one ever reached PayPal
      const found = await alertRows(a.order_id);
      expect(found[0]?.detail).toMatchObject({ in_flight_minor: 200, remote_remaining_minor: 300 });
      // Closing is the safe side: the money cannot be refunded twice, and the operator can ask again.
      expect(await ledger(unit.id)).toEqual([]);
    },
  );
});

describe('recovered requests keep the single-flight rule', () => {
  check('startup-style resend: the open request stays the only one until it settles', async () => {
    const { unit } = await setup();
    w.refundNext.lose_response = true;
    const rq = await request(unit.id, 200);
    await run(rq);
    w.refundNext.lose_response = false;
    expect(
      await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: usd(100),
        reason: 'x',
        actor: OPERATOR,
      }),
    ).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
    w.tick(31 * SEC);
    await runDue(w.deps, { max_items: 10 });
    expect((await reqRow(rq)).state).toBe('completed');
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
});
