import { describe, expect, it } from 'vitest';
import { buildCreateBody, checkCreate } from './build-create';
import { createReq } from './test-support';

const experience = {
  return_url: 'https://shop.example.invalid/checkout/return?ref=ord_SBX0001',
  cancel_url: 'https://shop.example.invalid/checkout/cancel?ref=ord_SBX0001',
  user_action: 'PAY_NOW',
  shipping_preference: 'NO_SHIPPING',
};

describe('create body', () => {
  it('create body built exactly as the rules for 1 and 2 units', () => {
    expect(buildCreateBody(createReq())).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'unit-1',
          custom_id: 'ord_SBX0001',
          invoice_id: 'ord_SBX0001',
          amount: { currency_code: 'USD', value: '5.00' },
          payee: { merchant_id: 'SBXMERCHANT01' },
        },
      ],
      payment_source: { paypal: { experience_context: experience } },
    });

    const two = createReq({
      units: [
        {
          reference_id: 'unit-1',
          payee_merchant_id: 'SBXMERCHANT01',
          amount: { currency: 'USD', minor: 300 },
        },
        {
          reference_id: 'unit-2',
          payee_merchant_id: 'SBXMERCHANT02',
          amount: { currency: 'USD', minor: 5 },
        },
      ],
    });
    expect(buildCreateBody(two)).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'unit-1',
          custom_id: 'ord_SBX0001',
          invoice_id: 'ord_SBX0001-0',
          amount: { currency_code: 'USD', value: '3.00' },
          payee: { merchant_id: 'SBXMERCHANT01' },
        },
        {
          reference_id: 'unit-2',
          custom_id: 'ord_SBX0001',
          invoice_id: 'ord_SBX0001-1',
          amount: { currency_code: 'USD', value: '0.05' },
          payee: { merchant_id: 'SBXMERCHANT02' },
        },
      ],
      payment_source: { paypal: { experience_context: experience } },
    });
  });

  it('omits payee when the merchant id is null, and keeps the key out of the JSON', () => {
    const body = buildCreateBody(
      createReq({
        units: [
          {
            reference_id: 'unit-1',
            payee_merchant_id: null,
            amount: { currency: 'USD', minor: 100 },
          },
        ],
      }),
    );
    expect(body.purchase_units[0]).not.toHaveProperty('payee');
    expect(JSON.stringify(body)).not.toContain('payee');
  });

  it('writes zero-decimal currencies without a decimal point', () => {
    const body = buildCreateBody(
      createReq({
        units: [
          { reference_id: 'u', payee_merchant_id: null, amount: { currency: 'JPY', minor: 500 } },
        ],
      }),
    );
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: 'JPY', value: '500' });
  });

  it('never puts a float or number in an amount', () => {
    const body = buildCreateBody(createReq());
    for (const u of body.purchase_units) {
      expect(typeof u.amount.value).toBe('string');
    }
  });
});

describe('invoice_id (DP-2a)', () => {
  it('invoice_id honoured: one unit carries the given invoice id, custom_id stays the order_ref', () => {
    const body = buildCreateBody(createReq({ invoice_id: 'ord_SBX0001-p2' }));
    expect(body.purchase_units[0]).toMatchObject({
      custom_id: 'ord_SBX0001',
      invoice_id: 'ord_SBX0001-p2',
    });
    expect(checkCreate(createReq({ invoice_id: 'ord_SBX0001-p2' }))).toBeNull();
  });
  it('without invoice_id the invoice id is what it always was', () => {
    expect(buildCreateBody(createReq()).purchase_units[0]?.invoice_id).toBe('ord_SBX0001');
  });
  it('invoice_id with two units refused before anything is sent', () => {
    const two = createReq({
      invoice_id: 'ord_SBX0001-p1',
      units: [
        {
          reference_id: 'unit-1',
          payee_merchant_id: 'SBXMERCHANT01',
          amount: { currency: 'USD', minor: 300 },
        },
        {
          reference_id: 'unit-2',
          payee_merchant_id: 'SBXMERCHANT02',
          amount: { currency: 'USD', minor: 5 },
        },
      ],
    });
    expect(checkCreate(two)).toMatchObject({
      kind: 'rejected',
      http: 400,
      name: 'REQUEST_INVALID',
    });
  });
  it('an invoice id over 127 characters is refused as FIELD_TOO_LONG or invalid, never sent', () => {
    expect(checkCreate(createReq({ invoice_id: 'i'.repeat(128) }))).toMatchObject({
      kind: 'rejected',
      http: 400,
    });
  });
  it('the payee of a unit that equals our own merchant id is left out (D-028) beside an invoice id', () => {
    const body = buildCreateBody(createReq({ invoice_id: 'ord_SBX0001-p1' }), 'SBXMERCHANT01');
    expect(body.purchase_units[0]).not.toHaveProperty('payee');
    expect(body.purchase_units[0]?.invoice_id).toBe('ord_SBX0001-p1');
  });
});
