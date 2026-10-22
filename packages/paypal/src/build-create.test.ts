import { describe, expect, it } from 'vitest';
import { buildCreateBody } from './build-create';
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
          { reference_id: 'unit-1', payee_merchant_id: null, amount: { currency: 'USD', minor: 100 } },
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
