import { describe, expect, it } from 'vitest';
import { mapError } from './errors';
import { createReq, harness, resp, scriptedTransport, secret } from './test-support';
import { APPROVE_HOST } from './test-support';

const TOKEN = 'A21AAKtestonlytokenvalue0123456789abcdef';
const CLIENT_ID = 'test-client-id-value';
const CLIENT_SECRET = 'test-client-secret-value';
const EMAIL = 'buyer.person@example.invalid';
const PAYER_ID = 'PAYERID12345X';
const ACCOUNT_ID = 'ACCT98765432Z';

const orderWithPii = {
  id: 'SBXORD00001',
  status: 'COMPLETED',
  payment_source: {
    paypal: {
      name: { given_name: 'Pat', surname: 'Example' },
      email_address: EMAIL,
      account_id: ACCOUNT_ID,
    },
  },
  purchase_units: [
    {
      reference_id: 'unit-1',
      custom_id: 'ord_SBX0001',
      amount: { currency_code: 'USD', value: '5.00' },
      payee: { merchant_id: 'SBXMERCHANT01', email_address: 'seller@example.invalid' },
      payments: {
        captures: [
          {
            id: 'SBXCAP00001',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '5.00' },
            create_time: '2026-01-01T10:00:00Z',
          },
        ],
      },
    },
  ],
  payer: { payer_id: PAYER_ID, email_address: EMAIL, name: { given_name: 'Pat' } },
  links: [{ href: `https://${APPROVE_HOST}/x?token=SBXORD00001`, rel: 'approve', method: 'GET' }],
};

describe('adversarial', () => {
  it('call records contain no token, secret, email or payer id', async () => {
    const t = scriptedTransport((r) => {
      if (r.operation === 'oauth_token') {
        return resp(200, {
          access_token: TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          app_id: 'APP-TEST',
          scope: 'https://uri.example.invalid/auth/scope',
          nonce: 'nonce-value',
        });
      }
      if (r.operation === 'get_capture') return resp(404, { name: 'RESOURCE_NOT_FOUND', debug_id: `d-${EMAIL}` });
      return resp(201, orderWithPii, { 'paypal-debug-id': 'dbg-1' });
    });
    const { adapter, records, log } = harness(t, {
      credentials: { client_id: secret(CLIENT_ID), client_secret: secret(CLIENT_SECRET) },
    });
    await adapter.createOrder(createReq());
    await adapter.getOrder('SBXORD00001');
    await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'umsK-1' });
    await adapter.getCapture('SBXCAP00001');
    await adapter.refundCapture({ capture_id: 'SBXCAP00001', request_id: 'umsR-1', amount: null, note: 'n' });

    expect(records.length).toBeGreaterThanOrEqual(6); // oauth + 5 calls
    const text = JSON.stringify(records) + JSON.stringify(log.events);
    for (const s of [
      TOKEN,
      'Bearer ',
      CLIENT_ID,
      CLIENT_SECRET,
      Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      EMAIL,
      'seller@example.invalid',
      PAYER_ID,
      ACCOUNT_ID,
      'Example',
      'nonce-value',
    ]) {
      expect(text, s).not.toContain(s);
    }
    // what must survive: the useful, non-secret fields
    expect(text).toContain('SBXORD00001');
    expect(records.some((r) => r.debug_id === 'dbg-1')).toBe(true);
    for (const r of records) {
      expect(r.transport_kind).toBe('dryrun');
      expect(typeof r.duration_ms).toBe('number');
    }
  });

  it('a response with an amount "0.1" for USD 0.10 maps to 10 minor units, never 0.1', async () => {
    const body = {
      id: 'SBXORD00001',
      status: 'COMPLETED',
      purchase_units: [
        {
          reference_id: 'unit-1',
          amount: { currency_code: 'USD', value: '0.1' },
          payments: {
            captures: [
              {
                id: 'SBXCAP00001',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '0.1' },
                create_time: '2026-01-01T10:00:00Z',
                seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '0.1' } },
              },
            ],
          },
        },
      ],
    };
    const { adapter } = harness(scriptedTransport(() => resp(200, body)));
    const r = await adapter.getOrder('SBXORD00001');
    expect(r).toMatchObject({
      kind: 'order',
      units: [{ amount: { currency: 'USD', minor: 10 }, capture: { paypal_fee_minor: 10 } }],
    });
    if (r.kind === 'order') {
      expect(Number.isInteger(r.units[0]?.amount.minor)).toBe(true);
      expect(JSON.stringify(r)).not.toContain('0.1');
    }
    const cap = await harness(scriptedTransport(() => resp(200, body.purchase_units[0]?.payments.captures[0]))).adapter.getCapture('SBXCAP00001');
    expect(cap).toMatchObject({ kind: 'capture', amount: { currency: 'USD', minor: 10 } });
  });

  it('unknown issue name maps by HTTP class', () => {
    const body = (issue: string) => ({
      name: 'BRAND_NEW_ERROR',
      message: 'PAYER_ACTION_REQUIRED ORDER_NOT_APPROVED text in the message must not matter',
      debug_id: 'd',
      details: [{ issue, description: 'PAYER_ACTION_REQUIRED in a description must not matter' }],
    });
    expect(mapError(422, body('NEVER_SEEN_BEFORE'), {})).toEqual({
      kind: 'rejected',
      http: 422,
      name: 'BRAND_NEW_ERROR',
      issue: 'NEVER_SEEN_BEFORE',
      debug_id: 'd',
    });
    expect(mapError(400, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'rejected', http: 400 });
    expect(mapError(403, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'rejected', http: 403 });
    expect(mapError(404, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'not_found' });
    expect(mapError(409, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'in_progress' });
    expect(mapError(429, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'unavailable' });
    expect(mapError(599, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'unavailable' });
    // other 4xx classes: a client error, kept as rejected 400 with the real name
    expect(mapError(415, body('NEVER_SEEN_BEFORE'), {})).toMatchObject({ kind: 'rejected', http: 400 });
    // an unexpected non-error status is outcome-unknown, never success
    expect(mapError(302, {}, {})).toMatchObject({ kind: 'unavailable' });
  });

  it('mapError never throws on hostile bodies and always returns a schema-valid failure', () => {
    const bodies: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      {},
      { name: 5, details: 'x', links: 'y' },
      { name: 'N'.repeat(10_000), details: [null, 1, { issue: {} }] },
      { details: [{ issue: 'ORDER_NOT_APPROVED' }], links: [null, { rel: 'payer-action', href: 5 }] },
    ];
    for (const status of [0, 99, 200, 302, 400, 401, 403, 404, 408, 409, 418, 422, 429, 500, 599, 700]) {
      for (const b of bodies) {
        const r = mapError(status, b, {});
        expect(typeof r.kind).toBe('string');
        if (r.kind === 'rejected') expect(r.name.length).toBeLessThanOrEqual(128);
      }
    }
  });
});
