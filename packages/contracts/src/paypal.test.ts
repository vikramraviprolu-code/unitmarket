import { describe, expect, it } from 'vitest';
import {
  CaptureReadSchema,
  CaptureResSchema,
  CaptureStatusSchema,
  CreateOrderReqSchema,
  CreateOrderResSchema,
  OrderReadSchema,
  PayPalFailSchema,
  ProviderEventSchema,
  ProviderEventTypeSchema,
  ProviderOrderIdSchema,
  ProviderOrderStatusSchema,
  RefundReqSchema,
  RefundResSchema,
  RefundStatusSchema,
  WebhookVerdictSchema,
} from './paypal';

const usd = (minor: number) => ({ currency: 'USD', minor });
const unit = { reference_id: 'unt_1', payee_merchant_id: 'MERCH1', amount: usd(500) };
const createReq = {
  request_id: 'r'.repeat(108),
  order_ref: 'ord_1',
  units: [unit],
  return_url: 'https://example.test/return',
  cancel_url: 'http://localhost:3000/cancel',
  scenario: null,
};
const part = {
  capture_id: 'CAP1',
  status: 'COMPLETED',
  status_reason: null,
  paypal_fee_minor: 30,
  refunded_minor: 0,
};

describe('ProviderOrderId', () => {
  it('ProviderOrderId rejects lowercase and 37 chars', () => {
    expect(ProviderOrderIdSchema.safeParse('5O190127TN364715T').success).toBe(true);
    expect(ProviderOrderIdSchema.safeParse('A'.repeat(36)).success).toBe(true);
    expect(ProviderOrderIdSchema.safeParse('A'.repeat(37)).success).toBe(false);
    expect(ProviderOrderIdSchema.safeParse('abc').success).toBe(false);
    expect(ProviderOrderIdSchema.safeParse('').success).toBe(false);
    expect(ProviderOrderIdSchema.safeParse('AB/../C').success).toBe(false);
    expect(ProviderOrderIdSchema.safeParse('AB?x=1').success).toBe(false);
    expect(ProviderOrderIdSchema.safeParse('AB\n').success).toBe(false);
  });
});

describe('verified enums', () => {
  it('CaptureStatus has no REVERSED; ProviderOrderStatus has SAVED and PAYER_ACTION_REQUIRED', () => {
    expect((CaptureStatusSchema.options as string[]).includes('REVERSED')).toBe(false);
    expect([...CaptureStatusSchema.options].sort()).toEqual([
      'COMPLETED',
      'DECLINED',
      'FAILED',
      'PARTIALLY_REFUNDED',
      'PENDING',
      'REFUNDED',
    ]);
    expect(ProviderOrderStatusSchema.options).toContain('SAVED');
    expect(ProviderOrderStatusSchema.options).toContain('PAYER_ACTION_REQUIRED');
    expect(ProviderOrderStatusSchema.options).toHaveLength(6);
    expect([...RefundStatusSchema.options].sort()).toEqual([
      'CANCELLED',
      'COMPLETED',
      'FAILED',
      'PENDING',
    ]);
    expect(ProviderEventTypeSchema.options).toHaveLength(9);
  });
});

describe('CreateOrderReq', () => {
  it('accepts a valid request and enforces limits', () => {
    expect(CreateOrderReqSchema.safeParse(createReq).success).toBe(true);
    expect(
      CreateOrderReqSchema.safeParse({ ...createReq, request_id: 'r'.repeat(109) }).success,
    ).toBe(false);
    expect(CreateOrderReqSchema.safeParse({ ...createReq, units: [] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...unit, reference_id: `unt_${i}` }));
    expect(CreateOrderReqSchema.safeParse({ ...createReq, units: eleven }).success).toBe(false);
    const ten = eleven.slice(0, 10);
    expect(CreateOrderReqSchema.safeParse({ ...createReq, units: ten }).success).toBe(true);
    expect(CreateOrderReqSchema.safeParse({ ...createReq, extra: 1 }).success).toBe(false);
  });
  it('refuses two currencies in one order', () => {
    const mixed = [unit, { ...unit, reference_id: 'unt_2', amount: { currency: 'EUR', minor: 5 } }];
    expect(CreateOrderReqSchema.safeParse({ ...createReq, units: mixed }).success).toBe(false);
  });
  it('refuses duplicate reference_id', () => {
    expect(CreateOrderReqSchema.safeParse({ ...createReq, units: [unit, unit] }).success).toBe(
      false,
    );
  });
});

describe('result unions', () => {
  it('PayPalFail variants', () => {
    const ok = (v: unknown) => expect(PayPalFailSchema.safeParse(v).success).toBe(true);
    const no = (v: unknown) => expect(PayPalFailSchema.safeParse(v).success).toBe(false);
    ok({ kind: 'rejected', http: 422, name: 'UNPROCESSABLE_ENTITY', issue: null, debug_id: 'd' });
    no({ kind: 'rejected', http: 500, name: 'x', issue: null, debug_id: null });
    ok({ kind: 'not_found', debug_id: null });
    ok({ kind: 'in_progress', debug_id: null });
    ok({ kind: 'payer_action', redirect_url: null, debug_id: null });
    ok({ kind: 'unavailable', retry_after_ms: 1000 });
    ok({ kind: 'timeout' });
    ok({ kind: 'blocked', by: 'budget' });
    no({ kind: 'blocked', by: 'live' });
    no({ kind: 'timeout', extra: 1 });
  });
  it('CreateOrderRes created or fail', () => {
    const created = {
      kind: 'created',
      provider_order_id: 'ABC123',
      status: 'CREATED',
      approve_url: 'https://example.test/approve',
      debug_id: null,
    };
    expect(CreateOrderResSchema.safeParse(created).success).toBe(true);
    expect(CreateOrderResSchema.safeParse({ kind: 'timeout' }).success).toBe(true);
    expect(CreateOrderResSchema.safeParse({ ...created, provider_order_id: 'abc' }).success).toBe(
      false,
    );
  });
  it('OrderRead, CaptureRes, CaptureRead, RefundRes', () => {
    expect(
      OrderReadSchema.safeParse({
        kind: 'order',
        provider_order_id: 'ABC',
        status: 'COMPLETED',
        custom_id: null,
        read_at: '2026-10-21T10:00:00Z',
        debug_id: null,
        units: [{ ...unit, capture: part }],
      }).success,
    ).toBe(true);
    expect(
      CaptureResSchema.safeParse({
        kind: 'claim',
        http: 201,
        provider_order_id: 'ABC',
        debug_id: null,
        units: [{ reference_id: 'unt_1', capture_id: null, status: null }],
      }).success,
    ).toBe(true);
    expect(
      CaptureResSchema.safeParse({
        kind: 'claim',
        http: 204,
        provider_order_id: 'ABC',
        debug_id: null,
        units: [],
      }).success,
    ).toBe(false);
    expect(
      CaptureReadSchema.safeParse({
        kind: 'capture',
        capture: part,
        amount: usd(500),
        read_at: '2026-10-21T10:00:00Z',
        debug_id: null,
      }).success,
    ).toBe(true);
    expect(
      RefundResSchema.safeParse({
        kind: 'refund',
        refund_id: 'R1',
        status: 'PENDING',
        amount: usd(5),
        capture_id: null,
        debug_id: null,
      }).success,
    ).toBe(true);
    expect(
      RefundReqSchema.safeParse({ capture_id: 'C', request_id: 'q', amount: null, note: 'n' })
        .success,
    ).toBe(true);
  });
  it('ProviderEvent and WebhookVerdict', () => {
    const event = {
      event_id: 'WH-1',
      transmission_id: 't',
      type: 'PAYMENT.CAPTURE.COMPLETED',
      provider_order_id: null,
      capture_id: 'C',
      refund_id: null,
      occurred_at: '2026-10-21T10:00:00Z',
    };
    expect(ProviderEventSchema.safeParse(event).success).toBe(true);
    expect(WebhookVerdictSchema.safeParse({ kind: 'verified', event }).success).toBe(true);
    expect(WebhookVerdictSchema.safeParse({ kind: 'bad_signature', why: 'x' }).success).toBe(true);
    expect(WebhookVerdictSchema.safeParse({ kind: 'malformed' }).success).toBe(true);
    expect(WebhookVerdictSchema.safeParse({ kind: 'unverifiable' }).success).toBe(true);
    expect(WebhookVerdictSchema.safeParse({ kind: 'verified' }).success).toBe(false);
  });
});
