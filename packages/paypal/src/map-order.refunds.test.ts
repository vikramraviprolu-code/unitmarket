// BU-4: the refund list of a purchase unit (purchase_units[].payments.refunds[]) as the order read
// maps it. A refund the mapper cannot read exactly makes the whole read `unavailable` (fail closed,
// ASM-12 rule): the refund send path must never compute PayPal's remaining amount from a partial
// list. Synthetic bodies only, no network. The list is not yet seen in the sandbox (ASM-53).
import { describe, expect, it } from 'vitest';
import { OrderReadSchema } from '@umsbx/contracts';
import { mapOrder } from './map-order';
import type { Http } from './shapes';

const NOW = new Date('2026-02-03T04:05:06Z');
const UNAVAILABLE = { kind: 'unavailable', retry_after_ms: null };
const http = (body: unknown): Http => ({ status: 200, headers: {}, body });

const usd = (value: string) => ({ currency_code: 'USD', value });
const capture = (over: Record<string, unknown> = {}) => ({
  id: 'SBXCAP00001',
  status: 'COMPLETED',
  amount: usd('5.00'),
  create_time: '2026-01-01T00:00:00Z',
  ...over,
});
const refund = (over: Record<string, unknown> = {}) => ({
  id: 'SBXREF00001',
  status: 'COMPLETED',
  amount: usd('3.00'),
  create_time: '2026-01-01T01:00:00Z',
  ...over,
});
const unit = (refunds: unknown, over: Record<string, unknown> = {}) => ({
  reference_id: 'unit-1',
  amount: usd('5.00'),
  payee: { merchant_id: 'SBXMERCHANT01' },
  payments: { captures: [capture()], ...(refunds === undefined ? {} : { refunds }) },
  ...over,
});
const order = (units: unknown[]) => ({
  id: 'SBXORD00001',
  status: 'COMPLETED',
  purchase_units: units,
});

type OrderResult = Extract<ReturnType<typeof mapOrder>['result'], { kind: 'order' }>;
const read = (units: unknown[]): OrderResult => {
  const { result } = mapOrder(http(order(units)), NOW);
  if (result.kind !== 'order') throw new Error(`expected an order, got ${result.kind}`);
  return result;
};

describe('mapOrder refunds', () => {
  it('maps id, status and minor units of each refund', () => {
    const r = read([
      unit([
        refund(),
        refund({ id: 'SBXREF00002', status: 'PENDING', amount: usd('1.25') }),
        refund({ id: 'SBXREF00003', status: 'FAILED', amount: usd('0.01') }),
        refund({ id: 'SBXREF00004', status: 'CANCELLED', amount: usd('0.00') }),
      ]),
    ]);
    expect(r.units[0]?.refunds).toEqual([
      { refund_id: 'SBXREF00001', status: 'COMPLETED', amount: { currency: 'USD', minor: 300 } },
      { refund_id: 'SBXREF00002', status: 'PENDING', amount: { currency: 'USD', minor: 125 } },
      { refund_id: 'SBXREF00003', status: 'FAILED', amount: { currency: 'USD', minor: 1 } },
      { refund_id: 'SBXREF00004', status: 'CANCELLED', amount: { currency: 'USD', minor: 0 } },
    ]);
  });

  it('keeps the order PayPal listed them in', () => {
    const r = read([
      unit([refund({ id: 'SBXREFB' }), refund({ id: 'SBXREFA' }), refund({ id: 'SBXREFC' })]),
    ]);
    expect(r.units[0]?.refunds?.map((x) => x.refund_id)).toEqual(['SBXREFB', 'SBXREFA', 'SBXREFC']);
  });

  it('a zero-decimal currency keeps its whole units', () => {
    const jpy = (value: string) => ({ currency_code: 'JPY', value });
    const r = read([
      unit([refund({ amount: jpy('300') })], {
        amount: jpy('500'),
        payments: {
          captures: [capture({ amount: jpy('500') })],
          refunds: [refund({ amount: jpy('300') })],
        },
      }),
    ]);
    expect(r.units[0]?.refunds).toEqual([
      { refund_id: 'SBXREF00001', status: 'COMPLETED', amount: { currency: 'JPY', minor: 300 } },
    ]);
  });

  it('no refunds in the body gives an empty list, not a missing one', () => {
    expect(read([unit(undefined)]).units[0]?.refunds).toEqual([]);
    expect(read([unit([])]).units[0]?.refunds).toEqual([]);
    expect(read([unit(undefined, { payments: undefined })]).units[0]?.refunds).toEqual([]);
    expect(read([unit(undefined, { payments: { captures: [] } })]).units[0]?.refunds).toEqual([]);
    expect(read([]).units).toEqual([]);
  });

  it('a unit with refunds but no capture still lists them', () => {
    const r = read([unit([refund()], { payments: { refunds: [refund()] } })]);
    expect(r.units[0]?.capture).toBeNull();
    expect(r.units[0]?.refunds).toHaveLength(1);
  });

  it('each unit gets its own list', () => {
    const r = read([
      unit([refund({ id: 'SBXREFU1' })]),
      unit([], { reference_id: 'unit-2' }),
      unit([refund({ id: 'SBXREFU3', amount: usd('0.50') })], { reference_id: 'unit-3' }),
    ]);
    expect(r.units.map((u) => u.refunds?.map((x) => x.refund_id))).toEqual([
      ['SBXREFU1'],
      [],
      ['SBXREFU3'],
    ]);
  });

  it('fields it does not use (links, notes, breakdowns) are ignored', () => {
    const r = read([
      unit([
        refund({
          note_to_payer: 'x',
          links: [{ rel: 'self', href: '/v2/payments/refunds/SBXREF00001' }],
          seller_payable_breakdown: { gross_amount: usd('3.00') },
        }),
      ]),
    ]);
    expect(r.units[0]?.refunds).toEqual([
      { refund_id: 'SBXREF00001', status: 'COMPLETED', amount: { currency: 'USD', minor: 300 } },
    ]);
  });

  it('the mapped read parses with the contracts schema', () => {
    const r = read([unit([refund(), refund({ id: 'SBXREF00002', status: 'PENDING' })])]);
    expect(OrderReadSchema.safeParse(r).success).toBe(true);
  });

  it('an unknown refund status makes the whole read unavailable', () => {
    for (const status of ['REVERSED', 'completed', 'PARTIALLY_REFUNDED', '', 'COMPLETE']) {
      const m = mapOrder(http(order([unit([refund({ status })])])), NOW);
      expect(m.result, status).toEqual(UNAVAILABLE);
      expect(m.notes).toContain('malformed_response');
    }
    for (const status of [undefined, null, 7, {}]) {
      const body = order([unit([refund({ status })])]);
      expect(mapOrder(http(body), NOW).result).toEqual(UNAVAILABLE);
    }
  });

  it('a bad refund in the second unit still makes the whole read unavailable', () => {
    const body = order([
      unit([refund()]),
      unit([refund({ status: 'REVERSED' })], { reference_id: 'unit-2' }),
    ]);
    expect(mapOrder(http(body), NOW).result).toEqual(UNAVAILABLE);
  });

  it('a refund in another currency than the unit makes the read unavailable', () => {
    const eur = { currency_code: 'EUR', value: '3.00' };
    const m = mapOrder(http(order([unit([refund({ amount: eur })])])), NOW);
    expect(m.result).toEqual(UNAVAILABLE);
    expect(m.notes).toContain('malformed_response');
  });

  it('a refund in another currency than the capture makes the read unavailable', () => {
    // The unit and its capture agree; only the refund differs.
    const gbp = { currency_code: 'GBP', value: '1.00' };
    expect(mapOrder(http(order([unit([refund({ amount: gbp })])])), NOW).result).toEqual(
      UNAVAILABLE,
    );
  });

  it('an unreadable amount makes the whole read unavailable', () => {
    const amounts: unknown[] = [
      undefined,
      null,
      '3.00',
      { currency_code: 'USD' },
      { value: '3.00' },
      { currency_code: 'USD', value: 3 },
      { currency_code: 'USD', value: '3.001' },
      { currency_code: 'USD', value: '-1.00' },
      { currency_code: 'USD', value: '1e2' },
      { currency_code: 'USD', value: '' },
      { currency_code: 'usd', value: '3.00' },
      { currency_code: 'USD', value: '99999999999999999999.99' },
    ];
    for (const amount of amounts) {
      const m = mapOrder(http(order([unit([refund({ amount })])])), NOW);
      expect(m.result, JSON.stringify(amount)).toEqual(UNAVAILABLE);
    }
  });

  it('a refund without a usable id makes the whole read unavailable', () => {
    for (const id of [undefined, null, '', 12, {}, 'X'.repeat(65)]) {
      expect(mapOrder(http(order([unit([refund({ id })])])), NOW).result).toEqual(UNAVAILABLE);
    }
    // 64 characters is the longest id the capture reader accepts; the refund reader matches it.
    expect(read([unit([refund({ id: 'X'.repeat(64) })])]).units[0]?.refunds).toHaveLength(1);
  });

  it('a refund list that is not a list of objects makes the whole read unavailable', () => {
    for (const refunds of [{}, 'x', 7, null, true, [null], ['x'], [7], [[]]]) {
      expect(mapOrder(http(order([unit(refunds)])), NOW).result, JSON.stringify(refunds)).toEqual(
        UNAVAILABLE,
      );
    }
  });

  it('refunds do not change what a read without them returned before', () => {
    const r = read([unit(undefined)]);
    expect(r.units[0]).toEqual({
      reference_id: 'unit-1',
      payee_merchant_id: 'SBXMERCHANT01',
      amount: { currency: 'USD', minor: 500 },
      capture: {
        capture_id: 'SBXCAP00001',
        status: 'COMPLETED',
        status_reason: null,
        amount: { currency: 'USD', minor: 500 },
        paypal_fee_minor: null,
        refunded_minor: 0,
      },
      refunds: [],
    });
  });

  it('the capture refunded total stays advisory beside the list', () => {
    const r = read([
      unit([refund()], {
        payments: {
          captures: [
            capture({
              status: 'PARTIALLY_REFUNDED',
              seller_receivable_breakdown: { total_refunded_amount: usd('3.00') },
            }),
          ],
          refunds: [refund()],
        },
      }),
    ]);
    expect(r.units[0]?.capture?.refunded_minor).toBe(300);
    expect(r.units[0]?.refunds).toHaveLength(1);
  });

  it('a unit with two captures lists every refund of the unit and takes the latest capture', () => {
    const older = capture({ id: 'SBXCAP00001', create_time: '2026-01-01T00:00:00Z' });
    const newer = capture({
      id: 'SBXCAP00002',
      amount: usd('2.00'),
      create_time: '2026-01-02T00:00:00Z',
    });
    const r = read([
      unit([refund({ id: 'SBXREFA' }), refund({ id: 'SBXREFB', amount: usd('1.00') })], {
        payments: {
          captures: [older, newer],
          refunds: [refund({ id: 'SBXREFA' }), refund({ id: 'SBXREFB', amount: usd('1.00') })],
        },
      }),
    ]);
    expect(r.units[0]?.capture?.capture_id).toBe('SBXCAP00002');
    expect(r.units[0]?.refunds?.map((x) => x.refund_id)).toEqual(['SBXREFA', 'SBXREFB']);
  });

  it('a refund id listed twice is listed twice', () => {
    const r = read([unit([refund(), refund()])]);
    expect(r.units[0]?.refunds).toHaveLength(2);
  });
});
