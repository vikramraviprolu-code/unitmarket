// CO-4 integration: refunds over the real PayPal adapter and the dry-run transport, with synthetic
// fixtures only (derived in memory from the `happy` scenario; labelled synthetic, not PayPal
// evidence). The journey: pay, a partial refund of UnitMarket (request, execute, read-back, book),
// a refund made at the PayPal dashboard (seen on a re-read, booked), "refund the rest" clamped to
// what PayPal holds, a full refund that ends access. INV1 to INV4 are checked after every step.
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { seededIds } from '@umsbx/runtime';
import { getReceiptForBuyer } from '@umsbx/receipts';
import type { Ids } from '@umsbx/contracts';
import {
  beginCheckout,
  checkInvariants,
  executeRefund,
  onBuyerReturn,
  placeOrder,
  reconcileOrder,
  requestRefund,
} from './index';
import { BUYER_A, dryRunDeps, makeWorld } from './support';
import type { DryRunFixture, World } from './support';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/paypal/', import.meta.url));
const OPERATOR = { kind: 'operator', operator_id: 'opr_1', mfa: true } as const;
const SCENARIO = 'co4';
const usd = (minor: number) => ({ currency: 'USD', minor });
const value = (minor: number) => (minor / 100).toFixed(2);

function fixtureIds(): Ids {
  const base = seededIds('co4-integration');
  let ord = 0;
  return {
    nonce: () => base.nonce(),
    next: (prefix) => {
      if (prefix === 'ord') {
        ord += 1;
        return ord === 1 ? 'ord_INTERNAL1' : 'ord_SBX0001';
      }
      if (prefix === 'unt') return 'unit-1';
      return base.next(prefix);
    },
  };
}

type Refund = { id: string; status: 'COMPLETED' | 'PENDING'; minor: number };
interface OrderBody {
  purchase_units: {
    payments: {
      captures: {
        status: string;
        seller_receivable_breakdown: { total_refunded_amount: unknown };
      }[];
      refunds: unknown;
    };
  }[];
}
interface RefundBody {
  id: string;
  status: string;
  amount: unknown;
}

/** A synthetic scenario `co4`: the happy exchanges plus the refund exchanges this journey needs. */
function scenario(base: DryRunFixture[]): DryRunFixture[] {
  const find = (operation: string, step: number): DryRunFixture => {
    const f = base.find(
      (x) => x.meta.scenario === 'happy' && x.meta.operation === operation && x.meta.step === step,
    );
    if (f === undefined) throw new Error(`no happy ${operation} ${step}`);
    return f;
  };
  const make = (
    src: DryRunFixture,
    operation: DryRunFixture['meta']['operation'],
    step: number,
    edit: (body: unknown) => void = () => undefined,
  ): DryRunFixture => {
    const f = structuredClone(src);
    f.meta.scenario = SCENARIO;
    f.meta.operation = operation;
    f.meta.step = step;
    f.meta.origin =
      'synthetic: derived in memory from the happy scenario for CO-4; not PayPal evidence';
    if ('timeout' in f.response) throw new Error('unexpected timeout fixture');
    edit(f.response.body);
    return f;
  };
  const orderRead = (step: number, capStatus: string, refunds: Refund[]): DryRunFixture =>
    make(find('get_order', 2), 'get_order', step, (raw) => {
      const payments = (raw as OrderBody).purchase_units[0]!.payments;
      const total = refunds
        .filter((r) => r.status === 'COMPLETED')
        .reduce((s, r) => s + r.minor, 0);
      payments.captures[0]!.status = capStatus;
      payments.captures[0]!.seller_receivable_breakdown.total_refunded_amount = {
        currency_code: 'USD',
        value: value(total),
      };
      payments.refunds = refunds.map((r) => ({
        id: r.id,
        status: r.status,
        amount: { currency_code: 'USD', value: value(r.minor) },
        note_to_payer: 'synthetic',
        create_time: '2026-01-01T11:00:00Z',
        update_time: '2026-01-01T11:00:00Z',
      }));
    });
  const refundCall = (
    operation: 'refund_capture' | 'get_refund',
    step: number,
    id: string,
    minor: number,
  ) =>
    make(find(operation, 1), operation, step, (raw) => {
      const body = raw as RefundBody;
      body.id = id;
      body.status = 'COMPLETED';
      body.amount = { currency_code: 'USD', value: value(minor) };
    });

  const mine: Refund = { id: 'SBXCO4REF00001', status: 'COMPLETED', minor: 200 };
  const dash: Refund = { id: 'SBXCO4DASH0001', status: 'COMPLETED', minor: 150 };
  const rest: Refund = { id: 'SBXCO4REF00002', status: 'COMPLETED', minor: 150 };
  return [
    make(find('create_order', 1), 'create_order', 1),
    make(find('get_order', 1), 'get_order', 1),
    make(find('capture_order', 1), 'capture_order', 1),
    make(find('get_order', 2), 'get_order', 2),
    // 3: the send check before the first refund (nothing refunded yet)
    orderRead(3, 'COMPLETED', []),
    refundCall('refund_capture', 1, mine.id, mine.minor),
    refundCall('get_refund', 1, mine.id, mine.minor),
    // 4: the read-back of that refund
    orderRead(4, 'PARTIALLY_REFUNDED', [mine]),
    // 5: a re-read; the dashboard refunded 1.50 beside ours
    orderRead(5, 'PARTIALLY_REFUNDED', [mine, dash]),
    // 6: the read of "refund the rest" at request time (and kept for the send check)
    orderRead(6, 'PARTIALLY_REFUNDED', [mine, dash]),
    refundCall('refund_capture', 2, rest.id, rest.minor),
    refundCall('get_refund', 2, rest.id, rest.minor),
    // 7: the read-back of the last refund; 8: one more re-read
    orderRead(7, 'REFUNDED', [mine, dash, rest]),
    orderRead(8, 'REFUNDED', [mine, dash, rest]),
  ];
}

let w: World;
afterEach(async () => {
  await w.close();
});

async function journey(drop: (f: DryRunFixture) => boolean = () => false) {
  w = await makeWorld({
    ids: fixtureIds(),
    price: 500,
    merchants: { pub_1: 'SBXMERCHANT01', pub_2: 'MERCH2' },
  });
  return dryRunDeps(w, {
    root: FIXTURE_ROOT,
    scenario: SCENARIO,
    derive: (all) => scenario(all).filter((f) => !drop(f)),
  });
}
const ops = (t: { calls(): { operation: string }[] }) => t.calls().map((c) => c.operation);
async function invariants(step: string): Promise<void> {
  const r = await checkInvariants(w.db);
  expect({ step, inv: r.slice(0, 4).map((x) => [x.id, x.ok]) }).toEqual({
    step,
    inv: [
      ['INV1', true],
      ['INV2', true],
      ['INV3', true],
      ['INV4', true],
    ],
  });
}
const unitRow = async () =>
  (
    await w.rows<{ id: string; status: string; refunded_minor: number }>(
      'SELECT id, status, refunded_minor FROM order_units',
    )
  )[0]!;
const ledger = async () =>
  (
    await w.rows<{ refund_id: string; amount_minor: number }>(
      "SELECT refund_id, amount_minor FROM ledger_entries WHERE kind = 'refund' ORDER BY amount_minor, refund_id",
    )
  ).map((x) => [x.refund_id, Number(x.amount_minor)]);
const access = async () =>
  (
    await w.rows<{ money_state: string; access_state: string }>(
      'SELECT money_state, access_state FROM entitlements',
    )
  )[0]!;

describe('refunds over the real adapter and the dry-run transport', () => {
  it('request, execute, read-back, book; a dashboard refund; the rest; a full refund; INV1 to INV4 after every step', async () => {
    const { transport, deps } = await journey();

    // Pay.
    const approval = await w.approval();
    const placed = await placeOrder(deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    if (!placed.ok) throw new Error('place refused');
    await beginCheckout(deps, { order_id: placed.value.order_id, actor: BUYER_A });
    const returned = await onBuyerReturn(deps, {
      order_ref: placed.value.order_ref,
      actor: BUYER_A,
    });
    expect(returned.ok && returned.value.status).toBe('paid');
    expect(ops(transport)).toEqual(['create_order', 'get_order', 'capture_order', 'get_order']);
    await invariants('paid');
    const order_id = placed.value.order_id;
    const unit = await unitRow();

    // Operator without MFA: nothing stored, no provider call.
    const before = transport.calls().length;
    expect(
      await requestRefund(deps, {
        unit_id: unit.id,
        amount: usd(200),
        reason: 'x',
        actor: { ...OPERATOR, mfa: false },
      }),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(transport.calls().length).toBe(before);
    await invariants('mfa refused');

    // 1. A partial refund of 2.00.
    const first = await requestRefund(deps, {
      unit_id: unit.id,
      amount: usd(200),
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!first.ok) throw new Error(`refused ${first.error.code}`);
    await invariants('requested');
    expect(
      await requestRefund(deps, {
        unit_id: unit.id,
        amount: usd(100),
        reason: 'again',
        actor: OPERATOR,
      }),
    ).toEqual({ ok: false, error: { code: 'refund_in_flight' } });
    expect(await executeRefund(deps, { refund_request_id: first.value.refund_request_id })).toEqual(
      {
        ok: true,
        value: { status: 'COMPLETED' },
      },
    );
    expect(ops(transport).slice(4)).toEqual([
      'get_order',
      'refund_capture',
      'get_refund',
      'get_order',
    ]);
    expect(await unitRow()).toMatchObject({ status: 'partially_refunded', refunded_minor: 200 });
    expect(await ledger()).toEqual([['SBXCO4REF00001', 200]]);
    expect(await access()).toEqual({ money_state: 'captured', access_state: 'available' });
    await invariants('partial refund booked');

    // 2. 1.50 refunded at the PayPal dashboard, seen on a re-read.
    await reconcileOrder(deps, { order_id, trigger: 'poll' });
    expect(await ledger()).toEqual([
      ['SBXCO4DASH0001', 150],
      ['SBXCO4REF00001', 200],
    ]);
    expect(await unitRow()).toMatchObject({ status: 'partially_refunded', refunded_minor: 350 });
    expect(await w.rows("SELECT 1 FROM alerts WHERE kind = 'refund_unbooked'")).toEqual([]);
    await invariants('dashboard refund booked');

    // 3. "Refund the rest" is what PayPal holds: 1.50, not the local 1.50 only by chance.
    const rest = await requestRefund(deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'rest',
      actor: OPERATOR,
    });
    if (!rest.ok) throw new Error(`refused ${rest.error.code}`);
    expect(
      (
        await w.rows<{ amount_minor: number }>(
          'SELECT amount_minor FROM refund_requests WHERE id = $1',
          [rest.value.refund_request_id],
        )
      )[0]!.amount_minor,
    ).toBe(150);
    expect(await executeRefund(deps, { refund_request_id: rest.value.refund_request_id })).toEqual({
      ok: true,
      value: { status: 'COMPLETED' },
    });
    expect(await unitRow()).toMatchObject({ status: 'refunded', refunded_minor: 500 });
    expect(await access()).toEqual({ money_state: 'refunded', access_state: 'revoked' });
    expect((await ledger()).map((x) => x[1])).toEqual([150, 150, 200]);
    await invariants('full');

    // 4. Another re-read changes nothing.
    await reconcileOrder(deps, { order_id, trigger: 'poll' });
    expect((await ledger()).length).toBe(3);
    await invariants('re-read');

    // The receipt shows all three refunds in version 4; every call was answered by a fixture.
    const receipt = (await getReceiptForBuyer(w.db, { order_id, buyer_id: 'buy_A' }))!;
    expect(receipt.version).toBe(4);
    expect(receipt.refunds.map((r) => [r.refund_id, r.amount.minor]).sort()).toEqual([
      ['SBXCO4DASH0001', 150],
      ['SBXCO4REF00001', 200],
      ['SBXCO4REF00002', 150],
    ]);
    expect(transport.calls().every((c) => c.outcome === 'response')).toBe(true);
    expect(transport.calls().every((c) => c.scenario === SCENARIO)).toBe(true);
  });

  it('a read the dry-run transport cannot answer is not a licence to send: no refund_capture call, the request waits', async () => {
    const { transport, deps } = await journey(
      (f) => f.meta.operation === 'get_order' && f.meta.step >= 3,
    );
    const approval = await w.approval();
    const placed = await placeOrder(deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    if (!placed.ok) throw new Error('place refused');
    await beginCheckout(deps, { order_id: placed.value.order_id, actor: BUYER_A });
    await onBuyerReturn(deps, { order_ref: placed.value.order_ref, actor: BUYER_A });
    const unit = await unitRow();
    const r = await requestRefund(deps, {
      unit_id: unit.id,
      amount: usd(100),
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    const res = await executeRefund(deps, { refund_request_id: r.value.refund_request_id });
    expect(res.ok).toBe(false);
    expect(transport.calls().filter((c) => c.operation === 'refund_capture')).toEqual([]);
    expect(transport.calls().at(-1)).toMatchObject({
      operation: 'get_order',
      outcome: 'blocked:dry_run_miss',
    });
    expect((await w.rows<{ state: string }>('SELECT state FROM refund_requests'))[0]!.state).toBe(
      'requested',
    );
    expect(await unitRow()).toMatchObject({ status: 'captured_verified', refunded_minor: 0 });
    await invariants('read blocked');
  });
});
