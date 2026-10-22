// Unit tests of the pure read-back match (lane 05a, P5, RB-4). One case per branch; the expected
// result is named in each case title. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { CaptureStatus, ClaimUnit, ExpectedTransaction, OrderRead } from '@umsbx/contracts';
import { matchReadback } from './index';

type Read = Extract<OrderRead, { kind: 'order' }>;
type Claim = ClaimUnit & { claimed_at: string | null };

const READ_AT = '2026-10-22T10:05:00.000Z';
const BEFORE = '2026-10-22T10:04:59.999Z';
const AFTER = '2026-10-22T10:05:00.001Z';

const expected = (over: Partial<ExpectedTransaction> = {}): ExpectedTransaction => ({
  order_ref: 'ord_REF',
  buyer_id: 'buy_A',
  content_hash: 'a'.repeat(64),
  currency: 'USD',
  total_minor: 650,
  units: [
    {
      reference_id: 'unt_1',
      publisher_id: 'pub_1',
      payee_merchant_id: 'MERCH1',
      amount_minor: 400,
    },
    {
      reference_id: 'unt_2',
      publisher_id: 'pub_2',
      payee_merchant_id: 'MERCH2',
      amount_minor: 250,
    },
  ],
  created_at: '2026-10-22T10:00:00.000Z',
  environment: 'dryrun',
  ...over,
});

const unitRead = (
  reference_id: string,
  payee: string,
  minor: number,
  capture: {
    id: string;
    status: CaptureStatus;
    reason?: string | null;
    fee?: number | null;
  } | null,
  currency = 'USD',
): Read['units'][number] => ({
  reference_id,
  payee_merchant_id: payee,
  amount: { currency, minor },
  capture:
    capture === null
      ? null
      : {
          capture_id: capture.id,
          status: capture.status,
          status_reason: capture.reason ?? null,
          amount: { currency, minor },
          paypal_fee_minor: capture.fee ?? null,
          refunded_minor: 0,
        },
});

const read = (over: Partial<Read> = {}, units?: Read['units']): Read => ({
  kind: 'order',
  provider_order_id: 'PPORDER1',
  status: 'COMPLETED',
  custom_id: 'ord_REF',
  read_at: READ_AT,
  debug_id: null,
  units: units ?? [
    unitRead('unt_1', 'MERCH1', 400, { id: 'CAP1', status: 'COMPLETED' }),
    unitRead('unt_2', 'MERCH2', 250, { id: 'CAP2', status: 'COMPLETED' }),
  ],
  ...over,
});

const NO_CLAIMS: Claim[] = [];
const run = (
  r: Read,
  o: { claims?: Claim[]; foreign?: string[]; exp?: ExpectedTransaction; provider?: string } = {},
) =>
  matchReadback({
    expected: o.exp ?? expected(),
    read: r,
    provider_order_id: o.provider ?? 'PPORDER1',
    claims: o.claims ?? NO_CLAIMS,
    foreign_capture_ids: o.foreign ?? [],
  });

const single = (r: Read, o: Parameters<typeof run>[1] = {}) => {
  const m = run(r, { ...o, exp: expected({ total_minor: 400, units: [expected().units[0]!] }) });
  if (m.level !== 'units') throw new Error(`expected unit level, got ${JSON.stringify(m)}`);
  return m.units[0]!;
};
const oneUnit = (capture: Parameters<typeof unitRead>[3], over: Partial<Read> = {}): Read =>
  read(over, [unitRead('unt_1', 'MERCH1', 400, capture)]);

describe('match: order level (the first failure wins)', () => {
  it('provider order id differs: order failure provider_order_id', () => {
    expect(run(read({ provider_order_id: 'OTHER' }))).toEqual({
      level: 'order',
      ok: false,
      field: 'provider_order_id',
    });
  });
  it('custom_id differs: order failure reference', () => {
    expect(run(read({ custom_id: 'ord_OTHER' }))).toEqual({
      level: 'order',
      ok: false,
      field: 'reference',
    });
  });
  it('custom_id absent: order failure reference', () => {
    expect(run(read({ custom_id: null }))).toEqual({
      level: 'order',
      ok: false,
      field: 'reference',
    });
  });
  it('provider id is checked before the reference: both wrong gives provider_order_id', () => {
    expect(run(read({ provider_order_id: 'OTHER', custom_id: 'x' }))).toMatchObject({
      field: 'provider_order_id',
    });
  });
  it('reference is checked before currency: both wrong gives reference', () => {
    const r = read({ custom_id: 'x' }, [
      unitRead('unt_1', 'MERCH1', 400, null, 'EUR'),
      unitRead('unt_2', 'MERCH2', 250, null, 'EUR'),
    ]);
    expect(run(r)).toMatchObject({ field: 'reference' });
  });
  it('one unit in EUR: order failure currency', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 400, { id: 'CAP1', status: 'COMPLETED' }),
      unitRead('unt_2', 'MERCH2', 250, { id: 'CAP2', status: 'COMPLETED' }, 'EUR'),
    ]);
    expect(run(r)).toEqual({ level: 'order', ok: false, field: 'currency' });
  });
  it('a read unit with an unknown id and the same count: order failure reference_id', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 400, null),
      unitRead('unt_zz', 'MERCH2', 250, null),
    ]);
    expect(run(r)).toEqual({ level: 'order', ok: false, field: 'reference_id' });
  });
  it('an additional unit with an unknown id: order failure extra_unit', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 400, null),
      unitRead('unt_2', 'MERCH2', 250, null),
      unitRead('unt_3', 'MERCH2', 1, null),
    ]);
    expect(run(r)).toEqual({ level: 'order', ok: false, field: 'extra_unit' });
  });
  it('a known id repeated (longer list): order failure extra_unit', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 400, null),
      unitRead('unt_2', 'MERCH2', 250, null),
      unitRead('unt_2', 'MERCH2', 250, null),
    ]);
    expect(run(r)).toEqual({ level: 'order', ok: false, field: 'extra_unit' });
  });
  it('a missing unit: order failure reference_id', () => {
    const r = read({}, [unitRead('unt_1', 'MERCH1', 400, null)]);
    expect(run(r)).toEqual({ level: 'order', ok: false, field: 'reference_id' });
  });
  it('a known id repeated in place of the other one: order failure reference_id', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 400, null),
      unitRead('unt_1', 'MERCH1', 400, null),
    ]);
    expect(run(r)).toEqual({ level: 'order', ok: false, field: 'reference_id' });
  });
});

describe('match: unit level, P5 order payee, amount, capture, claim, status', () => {
  it('other payee: mismatch payee', () => {
    const r = read({}, [unitRead('unt_1', 'OTHER', 400, { id: 'C', status: 'COMPLETED' })]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'payee' });
  });
  it('amount +1: mismatch amount', () => {
    const r = read({}, [unitRead('unt_1', 'MERCH1', 401, { id: 'C', status: 'COMPLETED' })]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'amount' });
  });
  it('amount -1: mismatch amount', () => {
    const r = read({}, [unitRead('unt_1', 'MERCH1', 399, { id: 'C', status: 'COMPLETED' })]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'amount' });
  });
  it('payee is checked before amount: both wrong gives payee', () => {
    const r = read({}, [unitRead('unt_1', 'OTHER', 999, { id: 'C', status: 'COMPLETED' })]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'payee' });
  });
  it('payee absent (null): mismatch payee', () => {
    const r = read({}, [
      { ...unitRead('unt_1', 'x', 400, { id: 'C', status: 'COMPLETED' }), payee_merchant_id: null },
    ]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'payee' });
  });
  it('a wrong payee wins over a missing capture: mismatch payee, not no_capture', () => {
    const r = read({}, [unitRead('unt_1', 'OTHER', 400, null)]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'payee' });
  });
  it('no capture on the unit: no_capture with status null', () => {
    expect(single(oneUnit(null))).toEqual({
      reference_id: 'unt_1',
      result: 'no_capture',
      field: null,
      status: null,
    });
  });
  it('COMPLETED with the right payee and amount: matched', () => {
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }))).toEqual({
      reference_id: 'unt_1',
      result: 'matched',
      field: null,
      status: 'COMPLETED',
    });
  });
  it('PARTIALLY_REFUNDED: matched', () => {
    expect(single(oneUnit({ id: 'C', status: 'PARTIALLY_REFUNDED' }))).toMatchObject({
      result: 'matched',
      status: 'PARTIALLY_REFUNDED',
    });
  });
  it('PENDING: pending, status kept', () => {
    expect(
      single(
        oneUnit({
          id: 'C',
          status: 'PENDING',
          reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION',
        }),
      ),
    ).toEqual({ reference_id: 'unt_1', result: 'pending', field: null, status: 'PENDING' });
  });
  it('DECLINED: declined', () => {
    expect(single(oneUnit({ id: 'C', status: 'DECLINED' }))).toMatchObject({
      result: 'declined',
      status: 'DECLINED',
    });
  });
  it('FAILED: declined', () => {
    expect(single(oneUnit({ id: 'C', status: 'FAILED' }))).toMatchObject({
      result: 'declined',
      status: 'FAILED',
    });
  });
  it('REFUNDED before any verified capture (no claim): mismatch capture_id, never matched', () => {
    expect(single(oneUnit({ id: 'C', status: 'REFUNDED' }))).toMatchObject({
      result: 'mismatch',
      field: 'capture_id',
      status: 'REFUNDED',
    });
  });
  it('REFUNDED against an unverified claim of the same capture: mismatch capture_id', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: 'C', status: null, claimed_at: BEFORE },
    ];
    expect(single(oneUnit({ id: 'C', status: 'REFUNDED' }), { claims })).toMatchObject({
      result: 'mismatch',
      field: 'capture_id',
    });
  });
  it('REFUNDED after a verified capture (claim with this capture id and no claim time): matched', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: 'C', status: null, claimed_at: null },
    ];
    expect(single(oneUnit({ id: 'C', status: 'REFUNDED' }), { claims })).toMatchObject({
      result: 'matched',
      status: 'REFUNDED',
    });
  });
  it('capture id held by another order: mismatch capture_id_reused', () => {
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { foreign: ['C'] })).toMatchObject({
      result: 'mismatch',
      field: 'capture_id_reused',
    });
  });
  it('a foreign id that the read does not show is ignored: matched', () => {
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { foreign: ['Z'] })).toMatchObject({
      result: 'matched',
    });
  });
  it('the same capture id on two units of the read: the second unit is capture_id_reused', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 400, { id: 'SAME', status: 'COMPLETED' }),
      unitRead('unt_2', 'MERCH2', 250, { id: 'SAME', status: 'COMPLETED' }),
    ]);
    const m = run(r);
    expect(m.level === 'units' && m.units.map((u) => [u.reference_id, u.result, u.field])).toEqual([
      ['unt_1', 'matched', null],
      ['unt_2', 'mismatch', 'capture_id_reused'],
    ]);
  });
  it('a capture id that another unit of this order claimed: capture_id_reused', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_2', capture_id: 'C', status: null, claimed_at: BEFORE },
    ];
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { claims })).toMatchObject({
      result: 'mismatch',
      field: 'capture_id_reused',
    });
  });
  it('the read shows another capture id than the claim: mismatch capture_id', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: 'CLAIMED', status: null, claimed_at: BEFORE },
    ];
    expect(single(oneUnit({ id: 'OTHER', status: 'COMPLETED' }), { claims })).toMatchObject({
      result: 'mismatch',
      field: 'capture_id',
    });
  });
  it('a claim without a capture id does not constrain the read: matched', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: null, status: null, claimed_at: BEFORE },
    ];
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { claims })).toMatchObject({
      result: 'matched',
    });
  });
  it('read taken before the claim was stored: pending read_before_claim', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: 'C', status: null, claimed_at: AFTER },
    ];
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { claims })).toMatchObject({
      result: 'pending',
      field: 'read_before_claim',
    });
  });
  it('read taken exactly at the claim time: matched', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: 'C', status: null, claimed_at: READ_AT },
    ];
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { claims })).toMatchObject({
      result: 'matched',
    });
  });
  it('read after the claim: matched', () => {
    const claims: Claim[] = [
      { reference_id: 'unt_1', capture_id: 'C', status: null, claimed_at: BEFORE },
    ];
    expect(single(oneUnit({ id: 'C', status: 'COMPLETED' }), { claims })).toMatchObject({
      result: 'matched',
    });
  });
  it('the fee never takes part: a huge or absent fee does not change the result', () => {
    for (const fee of [null, 0, 999_999]) {
      expect(single(oneUnit({ id: 'C', status: 'COMPLETED', fee }))).toMatchObject({
        result: 'matched',
      });
    }
  });
  it('units come back in reference id order whatever the read order', () => {
    const r = read({}, [
      unitRead('unt_2', 'MERCH2', 250, { id: 'CAP2', status: 'COMPLETED' }),
      unitRead('unt_1', 'MERCH1', 400, { id: 'CAP1', status: 'PENDING' }),
    ]);
    const m = run(r);
    expect(m.level === 'units' && m.units.map((u) => [u.reference_id, u.result])).toEqual([
      ['unt_1', 'pending'],
      ['unt_2', 'matched'],
    ]);
  });
  it('units come back in reference id order even when the expected list is in another order', () => {
    const exp = expected();
    const reversed = expected({ units: [exp.units[1]!, exp.units[0]!] });
    const m = run(read(), { exp: reversed });
    expect(m.level === 'units' && m.units.map((u) => u.reference_id)).toEqual(['unt_1', 'unt_2']);
    const three = expected({
      total_minor: 651,
      units: [
        { ...exp.units[1]!, reference_id: 'unt_c' },
        { ...exp.units[0]!, reference_id: 'unt_a', amount_minor: 401 },
        { ...exp.units[1]!, reference_id: 'unt_b', amount_minor: 0 },
      ],
    });
    const r = read({}, [
      unitRead('unt_b', 'MERCH2', 0, null),
      unitRead('unt_c', 'MERCH2', 250, null),
      unitRead('unt_a', 'MERCH1', 401, null),
    ]);
    const m3 = run(r, { exp: three });
    expect(m3.level === 'units' && m3.units.map((u) => u.reference_id)).toEqual([
      'unt_a',
      'unt_b',
      'unt_c',
    ]);
  });
  it('one bad unit does not hide a good one: both are reported', () => {
    const r = read({}, [
      unitRead('unt_1', 'MERCH1', 401, { id: 'CAP1', status: 'COMPLETED' }),
      unitRead('unt_2', 'MERCH2', 250, { id: 'CAP2', status: 'COMPLETED' }),
    ]);
    const m = run(r);
    expect(m.level === 'units' && m.units.map((u) => u.result)).toEqual(['mismatch', 'matched']);
  });
  it('the expected side is the only reference: a read that is internally consistent but not expected still fails', () => {
    // The read shows 800 on a unit expected at 400; nothing in the read can rebuild the expectation.
    const r = read({}, [unitRead('unt_1', 'MERCH1', 800, { id: 'C', status: 'COMPLETED' })]);
    expect(single(r)).toMatchObject({ result: 'mismatch', field: 'amount' });
  });
});
