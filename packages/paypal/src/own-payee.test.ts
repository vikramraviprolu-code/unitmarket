// BU-7 (D-028, option c): the create body leaves the payee out only for our own merchant id.
import { describe, expect, it } from 'vitest';
import type { CreateOrderReq } from '@umsbx/contracts';
import { createPayPalAdapter } from './adapter';
import { buildCreateBody } from './build-create';
import {
  APPROVE_HOST,
  createReq,
  memoryLogger,
  mutableClock,
  resp,
  scriptedTransport,
} from './test-support';

const OWN = 'SBXOWNMERCH01';
const unit = (payee: string | null, ref = 'unit-1') => ({
  reference_id: ref,
  payee_merchant_id: payee,
  amount: { currency: 'USD', minor: 500 },
});
const req = (payee: string | null): CreateOrderReq => createReq({ units: [unit(payee)] });
const payeeOf = (r: CreateOrderReq, own?: string | null) =>
  buildCreateBody(r, own).purchase_units.map((u) => u.payee);

describe('buildCreateBody: payee left out only on our own merchant id', () => {
  it('omits the payee when the unit payee equals our own id exactly', () => {
    const body = buildCreateBody(req(OWN), OWN);
    expect(body.purchase_units).toHaveLength(1);
    expect(body.purchase_units[0]).not.toHaveProperty('payee');
    expect(JSON.stringify(body)).not.toContain('payee');
    expect(JSON.stringify(body)).not.toContain(OWN);
  });

  it('keeps every other field of the unit when the payee is left out', () => {
    expect(buildCreateBody(req(OWN), OWN).purchase_units[0]).toEqual({
      reference_id: 'unit-1',
      custom_id: 'ord_SBX0001',
      invoice_id: 'ord_SBX0001',
      amount: { currency_code: 'USD', value: '5.00' },
    });
  });

  it.each([undefined, null])('own id %s: the payee is never left out', (own) => {
    expect(payeeOf(req(OWN), own)).toEqual([{ merchant_id: OWN }]);
    expect(payeeOf(req('SBXMERCHANT01'), own)).toEqual([{ merchant_id: 'SBXMERCHANT01' }]);
  });

  it('an empty own id never omits anything', () => {
    expect(payeeOf(req(OWN), '')).toEqual([{ merchant_id: OWN }]);
    expect(payeeOf(req(''), '')).toEqual([{ merchant_id: '' }]);
  });

  it('a unit with no payee at all stays without one (null payee)', () => {
    expect(payeeOf(req(null), OWN)).toEqual([undefined]);
  });

  it('another payee stays in the body', () => {
    expect(payeeOf(req('SBXMERCHANT01'), OWN)).toEqual([{ merchant_id: 'SBXMERCHANT01' }]);
  });

  it.each([
    ['lower case', OWN.toLowerCase()],
    ['mixed case', 'SbxOwnMerch01'],
    ['leading space', ` ${OWN}`],
    ['trailing space', `${OWN} `],
    ['trailing newline', `${OWN}\n`],
    ['tab inside', `SBXOWN\tMERCH01`],
    ['prefix of own id', OWN.slice(0, 12)],
    ['own id with a suffix', `${OWN}X`],
    ['own id as a prefix of a longer id', `${OWN}0`],
    ['zero for letter O', OWN.replace('O', '0')],
    ['Cyrillic S look-alike', `Ѕ${OWN.slice(1)}`],
    ['Cyrillic X look-alike', `SBХ${OWN.slice(3)}`],
    ['fullwidth letter', `Ｓ${OWN.slice(1)}`],
    ['zero-width space inside', `SBX​OWNMERCH01`],
    ['combining mark', `${OWN}́`],
    ['NFD form of a precomposed id', 'É'],
  ])('%s: the payee is kept', (_name, other) => {
    expect(payeeOf(req(other), OWN)).toEqual([{ merchant_id: other }]);
  });

  it('decides per unit: only the unit whose payee is our own loses it', () => {
    const r = createReq({
      units: [unit(OWN, 'unit-1'), unit('SBXMERCHANT01', 'unit-2'), unit(OWN, 'unit-3')],
    });
    expect(payeeOf(r, OWN)).toEqual([undefined, { merchant_id: 'SBXMERCHANT01' }, undefined]);
  });

  it('does not change the body of an order with no own-id unit', () => {
    const r = createReq();
    expect(buildCreateBody(r, OWN)).toEqual(buildCreateBody(r));
    expect(buildCreateBody(r, OWN)).toEqual(buildCreateBody(r, null));
  });

  it('is deterministic: the same request and own id give the same bytes (same-body retry)', () => {
    const a = JSON.stringify(buildCreateBody(req(OWN), OWN));
    const b = JSON.stringify(buildCreateBody(req(OWN), OWN));
    expect(a).toBe(b);
  });
});

describe('the adapter sends the body without our own payee', () => {
  const created = () =>
    resp(201, {
      id: 'SBXORD00001',
      status: 'CREATED',
      links: [{ href: `https://${APPROVE_HOST}/c?token=A`, rel: 'approve', method: 'GET' }],
    });
  const build = (own: string | null | undefined) => {
    const t = scriptedTransport(() => created());
    const adapter = createPayPalAdapter({
      transport: t,
      clock: mutableClock(),
      log: memoryLogger(),
      credentials: null,
      record: async () => undefined,
      ...(own === undefined ? {} : { own_merchant_id: own }),
    });
    return { t, adapter };
  };
  const sentBody = (t: { sent: { body: string | null }[] }) =>
    JSON.parse(t.sent[0]?.body ?? 'null') as { purchase_units: Record<string, unknown>[] };

  it('own id configured and equal: one send, no payee in the bytes', async () => {
    const { t, adapter } = build(OWN);
    expect((await adapter.createOrder(req(OWN))).kind).toBe('created');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.body).not.toContain('payee');
    expect(t.sent[0]?.body).not.toContain(OWN);
    expect(sentBody(t).purchase_units[0]).not.toHaveProperty('payee');
  });

  it.each([undefined, null])('own id %s: the payee goes out', async (own) => {
    const { t, adapter } = build(own);
    await adapter.createOrder(req(OWN));
    expect(sentBody(t).purchase_units[0]?.['payee']).toEqual({ merchant_id: OWN });
  });

  it('another payee goes out with its id', async () => {
    const { t, adapter } = build(OWN);
    await adapter.createOrder(req('SBXMERCHANT01'));
    expect(sentBody(t).purchase_units[0]?.['payee']).toEqual({ merchant_id: 'SBXMERCHANT01' });
  });

  it('the amount sent is still the amount asked for', async () => {
    const { t, adapter } = build(OWN);
    await adapter.createOrder(req(OWN));
    expect(t.sent[0]?.amount_minor).toBe(500);
    expect(sentBody(t).purchase_units[0]?.['amount']).toEqual({
      currency_code: 'USD',
      value: '5.00',
    });
  });
});
