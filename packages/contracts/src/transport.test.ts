import { describe, expect, it } from 'vitest';
import {
  BlockReasonSchema,
  GateVerdictSchema,
  OutboundRequestSchema,
  PayPalOperationSchema,
  TransportResultSchema,
} from './transport';

const req = {
  operation: 'create_order',
  method: 'POST',
  path: '/v2/checkout/orders',
  headers: { a: 'b' },
  body: '{}',
  order_ref: 'ord_1',
  amount_minor: 100,
  scenario: null,
};

describe('transport schemas', () => {
  it('PayPalOperation lists nine operations', () => {
    expect(PayPalOperationSchema.options).toHaveLength(9);
  });
  it('BlockReason has six reasons', () => {
    expect([...BlockReasonSchema.options].sort()).toEqual([
      'budget',
      'connect_off',
      'dry_run_miss',
      'egress',
      'kill_switch',
      'no_approval',
    ]);
  });
  it('OutboundRequest validates and refuses extras, bad method, float amount', () => {
    expect(OutboundRequestSchema.safeParse(req).success).toBe(true);
    expect(OutboundRequestSchema.safeParse({ ...req, extra: 1 }).success).toBe(false);
    expect(OutboundRequestSchema.safeParse({ ...req, method: 'DELETE' }).success).toBe(false);
    expect(OutboundRequestSchema.safeParse({ ...req, amount_minor: 1.5 }).success).toBe(false);
    expect(
      OutboundRequestSchema.safeParse({ ...req, operation: 'delete_everything' }).success,
    ).toBe(false);
  });
  it('TransportResult covers response, timeout, network_error, blocked', () => {
    const ok = (v: unknown) => expect(TransportResultSchema.safeParse(v).success).toBe(true);
    const no = (v: unknown) => expect(TransportResultSchema.safeParse(v).success).toBe(false);
    ok({ kind: 'response', status: 200, headers: {}, body: '', duration_ms: 3 });
    ok({ kind: 'timeout' });
    ok({ kind: 'network_error', code: 'ECONNRESET' });
    ok({ kind: 'blocked', by: 'dry_run_miss' });
    no({ kind: 'blocked', by: 'live' });
    no({ kind: 'timeout', extra: 1 });
  });
  it('GateVerdict allowed carries approval_ref; denied has four reasons only', () => {
    const ok = (v: unknown) => expect(GateVerdictSchema.safeParse(v).success).toBe(true);
    const no = (v: unknown) => expect(GateVerdictSchema.safeParse(v).success).toBe(false);
    ok({ allowed: true, approval_ref: 'oap_1' });
    ok({ allowed: false, by: 'budget' });
    no({ allowed: false, by: 'egress' });
    no({ allowed: false, by: 'dry_run_miss' });
    no({ allowed: true });
  });
});
