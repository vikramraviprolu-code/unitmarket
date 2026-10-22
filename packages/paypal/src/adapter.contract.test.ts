import { describe, expect, it } from 'vitest';
import {
  CaptureReadSchema,
  CaptureResSchema,
  CreateOrderResSchema,
  OrderReadSchema,
  RefundResSchema,
} from '@umsbx/contracts';
import { loadFixtures } from '@umsbx/transport';
import type { FixtureFile } from '@umsbx/transport';
import { createTokenCache } from './oauth';
import {
  FIXTURE_ROOT,
  createReq,
  dryRunTransport,
  harness,
  mutableClock,
  scriptedTransport,
  secret,
} from './test-support';
import type { TransportResult } from '@umsbx/contracts';

const toTransport = (fx: FixtureFile): TransportResult =>
  'timeout' in fx.response
    ? { kind: 'timeout' }
    : {
        kind: 'response',
        status: fx.response.status,
        headers: fx.response.headers,
        body:
          typeof fx.response.body === 'string' ? fx.response.body : JSON.stringify(fx.response.body),
        duration_ms: 1,
      };

describe('fixtures', () => {
  it('every fixture under fixtures/paypal maps without throwing and the result parses with its contracts schema', async () => {
    const fixtures = await loadFixtures(FIXTURE_ROOT);
    expect(fixtures.length).toBeGreaterThanOrEqual(60);
    let checked = 0;
    for (const fx of fixtures) {
      const label = `${fx.meta.scenario}/${fx.meta.operation}/${fx.meta.step}`;
      const t = scriptedTransport(() => toTransport(fx));
      const { adapter } = harness(t);
      const id = 'SBXORD00001';
      switch (fx.meta.operation) {
        case 'create_order':
          expect(CreateOrderResSchema.safeParse(await adapter.createOrder(createReq())).success, label).toBe(true);
          break;
        case 'get_order':
          expect(OrderReadSchema.safeParse(await adapter.getOrder(id)).success, label).toBe(true);
          break;
        case 'capture_order':
          expect(
            CaptureResSchema.safeParse(await adapter.captureOrder({ provider_order_id: id, request_id: 'k1' })).success,
            label,
          ).toBe(true);
          break;
        case 'get_capture':
          expect(CaptureReadSchema.safeParse(await adapter.getCapture('SBXCAP00001')).success, label).toBe(true);
          break;
        case 'refund_capture':
          expect(
            RefundResSchema.safeParse(
              await adapter.refundCapture({ capture_id: 'SBXCAP00001', request_id: 'k1', amount: null, note: 'n' }),
            ).success,
            label,
          ).toBe(true);
          break;
        case 'get_refund':
          expect(RefundResSchema.safeParse(await adapter.getRefund('SBXREF00001')).success, label).toBe(true);
          break;
        case 'oauth_token': {
          const cache = createTokenCache({
            transport: t,
            clock: mutableClock(),
            credentials: { client_id: secret('i'), client_secret: secret('s') },
            record: async () => {},
          });
          const r = await cache.get();
          expect(r.ok, label).toBe(false); // the only oauth fixture is the 401
          break;
        }
        default:
          // verify_webhook_postback and fetch_webhook_cert have no adapter path in MVP-A
          break;
      }
      checked += 1;
    }
    expect(checked).toBe(fixtures.length);
  });
});

describe('create', () => {
  it('201 with an approve link maps to created', async () => {
    const { adapter } = harness(await dryRunTransport('happy'));
    expect(await adapter.createOrder(createReq({ scenario: 'happy' }))).toEqual({
      kind: 'created',
      provider_order_id: 'SBXHAPPYORD00001',
      status: 'CREATED',
      approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=SBXHAPPYORD00001',
      debug_id: 'sbxdebug0001',
    });
  });

  it('docs-example payer-action create maps to created with PAYER_ACTION_REQUIRED', async () => {
    const { adapter } = harness(await dryRunTransport('docs_create_201_payer_action'));
    const r = await adapter.createOrder(createReq());
    expect(r).toMatchObject({
      kind: 'created',
      provider_order_id: '5O190127TN364715T',
      status: 'PAYER_ACTION_REQUIRED',
      approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
    });
  });

  it('duplicate invoice, 429 and 500 map by the table', async () => {
    const dup = harness(await dryRunTransport('duplicate_invoice'));
    expect(await dup.adapter.createOrder(createReq())).toMatchObject({
      kind: 'rejected',
      http: 422,
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'sbxdebug0054',
    });
    const rl = harness(await dryRunTransport('rate_limited_429'));
    expect(await rl.adapter.createOrder(createReq())).toEqual({ kind: 'unavailable', retry_after_ms: 2000 });
    expect((await rl.adapter.createOrder(createReq())).kind).toBe('created');
    const s5 = harness(await dryRunTransport('server_500'));
    expect(await s5.adapter.createOrder(createReq())).toEqual({ kind: 'unavailable', retry_after_ms: null });
  });
});

describe('capture', () => {
  it('docs-example capture 201 maps to claim with COMPLETED units and capture ids', async () => {
    const { adapter } = harness(await dryRunTransport('docs_capture_201'));
    expect(await adapter.captureOrder({ provider_order_id: '5O190127TN364715T', request_id: 'umsK-1' })).toEqual({
      kind: 'claim',
      http: 201,
      provider_order_id: '5O190127TN364715T',
      units: [{ reference_id: 'd9f80740-38f0-11e8-b467-0ed5f89f718b', capture_id: '3C679366HH908993F', status: 'COMPLETED' }],
      debug_id: null,
    });
  });

  it('207 maps per unit', async () => {
    const { adapter } = harness(await dryRunTransport('partial_207'));
    expect(await adapter.captureOrder({ provider_order_id: 'SBXPART207ORD0001', request_id: 'umsK-1' })).toEqual({
      kind: 'claim',
      http: 207,
      provider_order_id: 'SBXPART207ORD0001',
      units: [
        { reference_id: 'unit-1', capture_id: 'SBXPART207CAP001', status: 'COMPLETED' },
        { reference_id: 'unit-2', capture_id: 'SBXPART207CAP002', status: 'DECLINED' },
      ],
      debug_id: 'sbxdebug0038',
    });
  });

  it('202 maps to claim with no final units', async () => {
    const { adapter } = harness(await dryRunTransport('capture_202'));
    expect(await adapter.captureOrder({ provider_order_id: 'SBXCAP202ORD00001', request_id: 'umsK-1' })).toEqual({
      kind: 'claim',
      http: 202,
      provider_order_id: 'SBXCAP202ORD00001',
      units: [],
      debug_id: 'sbxdebug0033',
    });
  });

  it('a pending capture keeps its status', async () => {
    const { adapter } = harness(await dryRunTransport('pending_receiving_pref'));
    expect(await adapter.captureOrder({ provider_order_id: 'SBXPENDRPORD00001', request_id: 'k' })).toMatchObject({
      kind: 'claim',
      http: 201,
      units: [{ reference_id: 'unit-1', capture_id: 'SBXPENDRPCAP00001', status: 'PENDING' }],
    });
  });

  it('a lost response is a timeout, and the replay is a 200 claim', async () => {
    const { adapter } = harness(await dryRunTransport('lost_capture_response'));
    expect(await adapter.captureOrder({ provider_order_id: 'SBXLOSTORD00001', request_id: 'k' })).toEqual({ kind: 'timeout' });
    expect(await adapter.captureOrder({ provider_order_id: 'SBXLOSTORD00001', request_id: 'k' })).toMatchObject({
      kind: 'claim',
      http: 200,
      units: [{ status: 'COMPLETED' }],
    });
  });

  it('409 maps to in_progress', async () => {
    const { adapter } = harness(await dryRunTransport('docs_capture_409_in_progress'));
    expect(await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'k' })).toEqual({
      kind: 'in_progress',
      debug_id: 'sbxdebug0409a',
    });
  });

  it('422 ORDER_NOT_APPROVED and ORDER_ALREADY_CAPTURED map to rejected', async () => {
    const a = harness(await dryRunTransport('docs_capture_422_order_not_approved'));
    expect(await a.adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'k' })).toMatchObject({
      kind: 'rejected',
      http: 422,
      issue: 'ORDER_NOT_APPROVED',
    });
    const b = harness(await dryRunTransport('docs_capture_422_order_already_captured'));
    expect(await b.adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'k' })).toMatchObject({
      kind: 'rejected',
      http: 422,
      issue: 'ORDER_ALREADY_CAPTURED',
    });
  });
});

describe('read', () => {
  it('get order COMPLETED maps payee, amount, capture status, fee, refunded', async () => {
    const { adapter, records } = harness(await dryRunTransport('happy'));
    await adapter.createOrder(createReq({ scenario: 'happy' }));
    await adapter.getOrder('SBXHAPPYORD00001'); // step 1: APPROVED
    const r = await adapter.getOrder('SBXHAPPYORD00001'); // step 2: COMPLETED
    expect(r).toEqual({
      kind: 'order',
      provider_order_id: 'SBXHAPPYORD00001',
      status: 'COMPLETED',
      custom_id: 'ord_SBX0001',
      read_at: '2026-01-01T00:00:00.000Z',
      debug_id: 'sbxdebug0004',
      units: [
        {
          reference_id: 'unit-1',
          payee_merchant_id: 'SBXMERCHANT01',
          amount: { currency: 'USD', minor: 500 },
          capture: {
            capture_id: 'SBXHAPPYCAP00001',
            status: 'COMPLETED',
            status_reason: null,
            paypal_fee_minor: 45,
            refunded_minor: 0,
          },
        },
      ],
    });
    // the source of refunded_minor is recorded
    expect(records.at(-1)?.outcome).toContain('refunded_source=none');
  });

  it('an APPROVED order has units without a capture', async () => {
    const { adapter } = harness(await dryRunTransport('happy'));
    await adapter.createOrder(createReq({ scenario: 'happy' }));
    expect(await adapter.getOrder('SBXHAPPYORD00001')).toMatchObject({
      kind: 'order',
      status: 'APPROVED',
      units: [{ reference_id: 'unit-1', amount: { currency: 'USD', minor: 500 }, capture: null }],
    });
  });

  it('get order 404 maps to not_found', async () => {
    const { adapter } = harness(await dryRunTransport('docs_get_order_404'));
    expect(await adapter.getOrder('SBXORD00001')).toEqual({ kind: 'not_found', debug_id: 'sbxdebug0404a' });
  });

  it('mismatches are reported as read, never corrected', async () => {
    for (const [scenario, check] of [
      ['mismatch_amount', { units: [{ amount: { currency: 'USD', minor: 400 } }] }],
      ['mismatch_currency', { units: [{ amount: { currency: 'EUR', minor: 500 } }] }],
      ['mismatch_payee', { units: [{ payee_merchant_id: 'SBXMERCHANT99' }] }],
      ['mismatch_custom_id', { custom_id: 'ord_OTHER99' }],
    ] as const) {
      const { adapter } = harness(await dryRunTransport(scenario));
      expect(await adapter.getOrder('SBXORD00001'), scenario).toMatchObject(check);
    }
  });

  it('get capture maps status, fee, amount, reason', async () => {
    const h = harness(await dryRunTransport('happy'));
    expect(await h.adapter.getCapture('SBXHAPPYCAP00001')).toEqual({
      kind: 'capture',
      capture: {
        capture_id: 'SBXHAPPYCAP00001',
        status: 'COMPLETED',
        status_reason: null,
        paypal_fee_minor: 45,
        refunded_minor: 0,
      },
      amount: { currency: 'USD', minor: 500 },
      read_at: '2026-01-01T00:00:00.000Z',
      debug_id: 'sbxdebug0005',
    });
    const p = harness(await dryRunTransport('pending_receiving_pref'));
    expect(await p.adapter.getCapture('SBXPENDRPCAP00001')).toMatchObject({
      kind: 'capture',
      capture: { status: 'PENDING', status_reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION', paypal_fee_minor: null },
    });
  });

  it('the latest capture wins: by create_time, then by id', async () => {
    const order = (captures: unknown[]) => ({
      id: 'SBXORD00001',
      status: 'COMPLETED',
      purchase_units: [
        {
          reference_id: 'unit-1',
          amount: { currency_code: 'USD', value: '5.00' },
          payments: { captures },
        },
      ],
    });
    const cap = (id: string, status: string, create_time: string, extra: object = {}) => ({
      id,
      status,
      amount: { currency_code: 'USD', value: '5.00' },
      create_time,
      ...extra,
    });
    const run = async (captures: unknown[]) => {
      const { adapter } = harness(
        scriptedTransport(() => ({
          kind: 'response',
          status: 200,
          headers: {},
          body: JSON.stringify(order(captures)),
          duration_ms: 1,
        })),
      );
      const r = await adapter.getOrder('SBXORD00001');
      return r.kind === 'order' ? r.units[0]?.capture?.capture_id : r.kind;
    };
    expect(
      await run([cap('CAPA', 'DECLINED', '2026-01-01T10:00:00Z'), cap('CAPB', 'COMPLETED', '2026-01-01T11:00:00Z')]),
    ).toBe('CAPB');
    expect(
      await run([cap('CAPB', 'COMPLETED', '2026-01-01T11:00:00Z'), cap('CAPA', 'DECLINED', '2026-01-01T10:00:00Z')]),
    ).toBe('CAPB');
    expect(
      await run([cap('CAPA', 'DECLINED', '2026-01-01T10:00:00Z'), cap('CAPB', 'COMPLETED', '2026-01-01T10:00:00Z')]),
    ).toBe('CAPB');
    expect(
      await run([cap('CAPB', 'DECLINED', '2026-01-01T10:00:00Z'), cap('CAPA', 'COMPLETED', '2026-01-01T10:00:00Z')]),
    ).toBe('CAPB');
  });

  it('refunded_minor comes from the receivable breakdown when present and the source is recorded', async () => {
    const body = {
      id: 'SBXORD00001',
      status: 'COMPLETED',
      purchase_units: [
        {
          reference_id: 'unit-1',
          amount: { currency_code: 'USD', value: '5.00' },
          payments: {
            captures: [
              {
                id: 'CAPA',
                status: 'PARTIALLY_REFUNDED',
                amount: { currency_code: 'USD', value: '5.00' },
                create_time: '2026-01-01T10:00:00Z',
                seller_receivable_breakdown: {
                  gross_amount: { currency_code: 'USD', value: '5.00' },
                  paypal_fee: { currency_code: 'USD', value: '0.45' },
                  total_refunded_amount: { currency_code: 'USD', value: '1.25' },
                },
              },
            ],
          },
        },
      ],
    };
    const { adapter, records } = harness(
      scriptedTransport(() => ({ kind: 'response', status: 200, headers: {}, body: JSON.stringify(body), duration_ms: 1 })),
    );
    expect(await adapter.getOrder('SBXORD00001')).toMatchObject({
      units: [{ capture: { status: 'PARTIALLY_REFUNDED', paypal_fee_minor: 45, refunded_minor: 125 } }],
    });
    expect(records[0]?.outcome).toContain('refunded_source=seller_receivable_breakdown');
  });

  it('a body that cannot be read safely is unavailable, not a throw', async () => {
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      { id: 'lowercase', status: 'COMPLETED', purchase_units: [] },
      { id: 'SBXORD00001', status: 'WEIRD', purchase_units: [] },
      { id: 'SBXORD00001', status: 'COMPLETED', purchase_units: [{ reference_id: 'u', amount: { currency_code: 'USD', value: '1e2' } }] },
      { id: 'SBXORD00001', status: 'COMPLETED', purchase_units: [{ reference_id: 'u', amount: { currency_code: 'USD', value: '1.005' } }] },
    ];
    for (const b of bad) {
      const { adapter } = harness(
        scriptedTransport(() => ({
          kind: 'response',
          status: 200,
          headers: {},
          body: typeof b === 'string' ? b : JSON.stringify(b),
          duration_ms: 1,
        })),
      );
      expect(await adapter.getOrder('SBXORD00001'), JSON.stringify(b)).toEqual({
        kind: 'unavailable',
        retry_after_ms: null,
      });
    }
  });
});

describe('refund', () => {
  it('docs-example refund 201 maps to a refund result', async () => {
    const { adapter } = harness(await dryRunTransport('docs_refund_201'));
    expect(
      await adapter.refundCapture({ capture_id: '7TK53561YB803214S', request_id: 'umsR-1', amount: null, note: 'test' }),
    ).toEqual({
      kind: 'refund',
      refund_id: '58K15806CS993444T',
      status: 'COMPLETED',
      amount: { currency: 'USD', minor: 8900 },
      capture_id: '7TK53561YB803214S',
      debug_id: null,
    });
  });

  it('sends the amount as a decimal string and the note', async () => {
    const t = scriptedTransport(() => ({
      kind: 'response',
      status: 201,
      headers: {},
      body: JSON.stringify({ id: 'REF1', status: 'PENDING', amount: { currency_code: 'USD', value: '1.25' } }),
      duration_ms: 1,
    }));
    const { adapter } = harness(t);
    const r = await adapter.refundCapture({
      capture_id: 'SBXCAP00001',
      request_id: 'umsR-1',
      amount: { currency: 'USD', minor: 125 },
      note: 'goodwill',
    });
    expect(r).toMatchObject({ kind: 'refund', status: 'PENDING', amount: { currency: 'USD', minor: 125 }, capture_id: null });
    expect(t.sent[0]?.path).toBe('/v2/payments/captures/SBXCAP00001/refund');
    expect(JSON.parse(t.sent[0]?.body ?? 'null')).toEqual({
      amount: { currency_code: 'USD', value: '1.25' },
      note_to_payer: 'goodwill',
    });
    expect(t.sent[0]?.amount_minor).toBe(125);
  });

  it('get refund maps the synthetic happy refund', async () => {
    const { adapter } = harness(await dryRunTransport('happy'));
    expect(await adapter.getRefund('SBXHAPPYREF00001')).toMatchObject({
      kind: 'refund',
      refund_id: 'SBXHAPPYREF00001',
      status: 'COMPLETED',
      amount: { currency: 'USD', minor: 500 },
      capture_id: 'SBXHAPPYCAP00001',
    });
  });
});
