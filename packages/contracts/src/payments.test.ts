import { describe, expect, it } from 'vitest';
import {
  MatchResultSchema,
  MoneyEventSchema,
  MoneyStateSchema,
  OperationFailureSchema,
  OperationKindSchema,
  OperationStateSchema,
  OrderStatusSchema,
  UnitMatchSchema,
  UnitStatusSchema,
  MatchFieldSchema,
} from './payments';

describe('payments enums', () => {
  it('have the spec values', () => {
    expect([...OperationKindSchema.options]).toEqual([
      'create',
      'capture',
      'readback',
      'refund',
      'refund_readback',
    ]);
    expect([...OperationStateSchema.options]).toEqual([
      'prepared',
      'sent',
      'unknown',
      'confirmed',
      'failed',
    ]);
    expect(OperationFailureSchema.options).toHaveLength(6);
    expect(OrderStatusSchema.options).toHaveLength(10);
    expect(UnitStatusSchema.options).toHaveLength(9);
    expect(MoneyStateSchema.options).toHaveLength(6);
    expect(MoneyEventSchema.options).toHaveLength(6);
    expect(MatchFieldSchema.options).toHaveLength(10);
    expect((OrderStatusSchema.options as string[]).includes('live')).toBe(false);
  });
});

describe('MatchResult', () => {
  const um = { reference_id: 'unt_1', result: 'matched', field: null, status: 'COMPLETED' };
  it('accepts order-level failure and unit-level success', () => {
    expect(UnitMatchSchema.safeParse(um).success).toBe(true);
    expect(
      MatchResultSchema.safeParse({ level: 'order', ok: false, field: 'currency' }).success,
    ).toBe(true);
    expect(MatchResultSchema.safeParse({ level: 'units', ok: true, units: [um] }).success).toBe(
      true,
    );
  });
  it('refuses mixed shapes', () => {
    expect(
      MatchResultSchema.safeParse({ level: 'order', ok: true, field: 'currency' }).success,
    ).toBe(false);
    expect(MatchResultSchema.safeParse({ level: 'units', ok: false, units: [] }).success).toBe(
      false,
    );
    expect(
      MatchResultSchema.safeParse({ level: 'order', ok: false, field: 'colour' }).success,
    ).toBe(false);
  });
});
