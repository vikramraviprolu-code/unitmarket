// Replaces the lane 00 placeholder test (PACKAGE_NAME is gone: the spec's export snapshot rules).
import { describe, expect, it } from 'vitest';
import * as contracts from './index';

// Every runtime export the spec defines. Types are erased; each type T has a `TSchema` here.
const EXPECTED_EXPORTS: string[] = [
  // F1 primitives
  'IdSchema',
  'MinorUnitsSchema',
  'CurrencyCodeSchema',
  'IsoUtcSchema',
  'Sha256HexSchema',
  'EnvironmentLabelSchema',
  'MoneySchema',
  // F1 result
  'ok',
  'err',
  // F1 ports
  'IdPrefixSchema',
  'SecretSchema',
  'LogLevelSchema',
  'LogFieldsSchema',
  'LogEventSchema',
  'AuditEntrySchema',
  'ContentHeadSchema',
  'ModelPurposeSchema',
  'ModelRequestSchema',
  'ModelResponseSchema',
  'SwitchNameSchema',
  // F1 actor
  'ActorSchema',
  // F2 transport
  'PayPalOperationSchema',
  'OutboundRequestSchema',
  'BlockReasonSchema',
  'TransportResultSchema',
  'GateVerdictSchema',
  // F2 paypal
  'ProviderOrderIdSchema',
  'ProviderOrderStatusSchema',
  'CaptureStatusSchema',
  'RefundStatusSchema',
  'PayPalFailSchema',
  'CreateOrderUnitSchema',
  'CreateOrderReqSchema',
  'CreateOrderResSchema',
  'CapturedPartSchema',
  'OrderReadUnitSchema',
  'OrderReadSchema',
  'ClaimUnitSchema',
  'CaptureResSchema',
  'CaptureReadSchema',
  'RefundReqSchema',
  'RefundResSchema',
  'ProviderEventTypeSchema',
  'ProviderEventSchema',
  'WebhookVerdictSchema',
];

type Walkable = { _zod: { def: { type: string; catchall?: Walkable; options?: Walkable[] } } };

// Every object schema must be strict (catchall never): an extra key is refused (mass-assignment guard).
const nonStrict = (s: Walkable, path: string): string[] => {
  const def = s._zod.def;
  if (def.type === 'object') return def.catchall?._zod.def.type === 'never' ? [] : [path];
  if (def.type === 'union')
    return (def.options ?? []).flatMap((o, i) => nonStrict(o, `${path}[${i}]`));
  return [];
};

describe('index', () => {
  it('index exports every name listed in this spec', () => {
    expect(Object.keys(contracts).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it('every schema is strict', () => {
    const offenders = Object.entries(contracts)
      .filter(([k]) => k.endsWith('Schema'))
      .flatMap(([k, v]) => nonStrict(v as Walkable, k));
    expect(offenders).toEqual([]);
  });
});
