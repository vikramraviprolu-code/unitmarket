// Opus review 3 findings M6, L1, L2, L3, L4 for the PayPal adapter. Synthetic bodies only.
import { describe, expect, it } from 'vitest';
import { createTokenCache } from './oauth';
import { fromDecimalString } from './money';
import { harness, mutableClock, resp, scriptedTransport, secret } from './test-support';
import type { ProviderCallRecord } from './adapter';

const cap = (over: Record<string, unknown> = {}) => ({
  id: 'SBXCAP00001',
  status: 'COMPLETED',
  amount: { currency_code: 'USD', value: '5.00' },
  create_time: '2026-01-01T00:00:00Z',
  ...over,
});
const order = (capture: unknown) => ({
  id: 'SBXORD00001',
  status: 'COMPLETED',
  purchase_units: [
    {
      reference_id: 'unit-1',
      amount: { currency_code: 'USD', value: '5.00' },
      payee: { merchant_id: 'SBXMERCHANT01' },
      payments: { captures: capture === null ? [] : [capture] },
    },
  ],
});

describe('M6 capture amount on CapturedPart', () => {
  it('getOrder maps the capture amount', async () => {
    const { adapter } = harness(scriptedTransport(() => resp(200, order(cap()))));
    const r = await adapter.getOrder('SBXORD00001');
    expect(r).toMatchObject({
      kind: 'order',
      units: [{ capture: { amount: { currency: 'USD', minor: 500 } } }],
    });
  });

  it('a 5.00 USD unit with a capture of 500.00 EUR keeps both amounts so payments can compare', async () => {
    const eur = cap({ amount: { currency_code: 'EUR', value: '500.00' } });
    const { adapter } = harness(scriptedTransport(() => resp(200, order(eur))));
    const r = await adapter.getOrder('SBXORD00001');
    expect(r).toMatchObject({
      kind: 'order',
      units: [
        {
          amount: { currency: 'USD', minor: 500 },
          capture: { amount: { currency: 'EUR', minor: 50000 } },
        },
      ],
    });
  });

  it('getCapture carries the amount on the part as well as the top level', async () => {
    const { adapter } = harness(scriptedTransport(() => resp(200, cap())));
    const r = await adapter.getCapture('SBXCAP00001');
    expect(r).toMatchObject({
      kind: 'capture',
      amount: { currency: 'USD', minor: 500 },
      capture: { amount: { currency: 'USD', minor: 500 } },
    });
  });

  it('an order capture without an amount reads as unavailable (malformed)', async () => {
    const noAmount = cap();
    delete (noAmount as Record<string, unknown>).amount;
    const { adapter } = harness(scriptedTransport(() => resp(200, order(noAmount))));
    expect(await adapter.getOrder('SBXORD00001')).toEqual({
      kind: 'unavailable',
      retry_after_ms: null,
    });
  });
});

describe('L1 oauth transport exception', () => {
  it('a throwing transport maps to timeout, never a rejected promise', async () => {
    const records: ProviderCallRecord[] = [];
    const cache = createTokenCache({
      transport: {
        kind: 'dryrun',
        send: async () => {
          throw new Error('socket exploded with secret-ish text');
        },
      },
      clock: mutableClock(),
      credentials: { client_id: secret('a'), client_secret: secret('b') },
      record: async (c) => {
        records.push(c);
      },
    });
    expect(await cache.get()).toEqual({ ok: false, error: { kind: 'timeout' } });
    // single-flight state is cleared: a second call tries again and also resolves
    expect(await cache.get()).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(JSON.stringify(records)).not.toContain('socket exploded');
  });
});

describe('L2 capture body order id', () => {
  it('a 201 whose body id differs from the requested id is unavailable', async () => {
    const body = { id: 'SBXOTHERORD0001', status: 'COMPLETED', purchase_units: [] };
    const { adapter } = harness(scriptedTransport(() => resp(201, body)));
    expect(
      await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'umsK-1' }),
    ).toEqual({ kind: 'unavailable', retry_after_ms: null });
  });

  it('a matching id is still a claim', async () => {
    const body = { id: 'SBXORD00001', status: 'COMPLETED', purchase_units: [] };
    const { adapter } = harness(scriptedTransport(() => resp(201, body)));
    expect(
      await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'umsK-1' }),
    ).toMatchObject({ kind: 'claim', provider_order_id: 'SBXORD00001' });
  });
});

describe('L3 refunded amounts are advisory', () => {
  it('the call record says refunds must come from GET refund (05b)', async () => {
    const { adapter, records } = harness(
      scriptedTransport((r) => resp(200, r.operation === 'get_order' ? order(cap()) : cap())),
    );
    await adapter.getOrder('SBXORD00001');
    await adapter.getCapture('SBXCAP00001');
    for (const r of records) expect(r.outcome).toContain('refunded_advisory=use_get_refund');
  });
});

describe('L4 amount strings', () => {
  it('refuses a leading dot and leading zeros', () => {
    for (const v of ['.5', '007.50', '00', '01', '00.50']) {
      expect(fromDecimalString(v, 'USD', 2), v).toEqual({ ok: false, error: 'bad_amount' });
    }
  });
  it('still accepts a single zero whole part and plain numbers', () => {
    expect(fromDecimalString('0.50', 'USD', 2)).toEqual({
      ok: true,
      value: { currency: 'USD', minor: 50 },
    });
    expect(fromDecimalString('0', 'USD', 2)).toMatchObject({ ok: true });
    expect(fromDecimalString('7.5', 'USD', 2)).toMatchObject({ ok: true });
    expect(fromDecimalString('10', 'JPY', 0)).toMatchObject({ ok: true });
  });
});
