// Replaces the lane 00 placeholder test (PACKAGE_NAME is gone: the spec's export snapshot rules).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
  'isUrlUnderOrigin',
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
  // F3 corridor, catalogue, quote
  'CorridorIdSchema',
  'CorridorSchema',
  'AccessOptionSchema',
  'AccessPolicySchema',
  'RightsSchema',
  'OfferOptionSchema',
  'AffordabilitySchema',
  'OfferSchema',
  'ArticleFactsSchema',
  'PublisherFactsSchema',
  'NoMatchReasonSchema',
  'QuoteSchema',
  'NoMatchSchema',
  // F3 approval
  'SnapshotItemSchema',
  'SnapshotPublisherSchema',
  'ApprovalSnapshotSchema',
  'APPROVAL_TTL_MS',
  'ApprovalSchema',
  'ExpectedUnitSchema',
  'ExpectedTransactionSchema',
  // F3 payments, entitlements, access
  'OperationKindSchema',
  'OperationStateSchema',
  'OperationFailureSchema',
  'OrderStatusSchema',
  'UnitStatusSchema',
  'MoneyStateSchema',
  'MoneyEventSchema',
  'MatchFieldSchema',
  'UnitMatchSchema',
  'MatchResultSchema',
  'AccessStateSchema',
  'LicenceStateSchema',
  'WindowStateNameSchema',
  'WindowStateSchema',
  'AccessEventKindSchema',
  'AccessEventSchema',
  // F3 ledger, receipts, recovery, fit, config
  'LedgerKindSchema',
  'LedgerEntryInputSchema',
  'LedgerEntrySchema',
  'ReceiptLineSchema',
  'ReceiptSchema',
  'CaseKindSchema',
  'CaseStateSchema',
  'CaseViewSchema',
  'FitDimensionSchema',
  'FitCardSchema',
  'BriefSchema',
  'DomainConfigSchema',
];

type Def = {
  type: string;
  catchall?: Walkable;
  shape?: Record<string, Walkable>;
  options?: Walkable[];
  element?: Walkable;
  innerType?: Walkable;
  in?: Walkable;
  out?: Walkable;
  left?: Walkable;
  right?: Walkable;
  keyType?: Walkable;
  valueType?: Walkable;
  items?: Walkable[];
  rest?: Walkable | null;
  getter?: () => Walkable;
};
type Walkable = { _zod: { def: Def } };

// Every object schema must be strict (catchall never): an extra key is refused (mass-assignment
// guard). The walk goes through nested objects, arrays, tuples, records, unions, intersections,
// optional/nullable/readonly wrappers, pipes (transforms) and lazy schemas (L3).
const nonStrict = (s: Walkable, path: string, seen = new Set<Walkable>()): string[] => {
  if (seen.has(s)) return [];
  seen.add(s);
  const def = s._zod.def;
  const out: string[] = [];
  const child = (c: Walkable | null | undefined, p: string) => {
    if (c) out.push(...nonStrict(c, p, seen));
  };
  if (def.type === 'object') {
    if (def.catchall?._zod.def.type !== 'never') out.push(path);
    for (const [k, v] of Object.entries(def.shape ?? {})) child(v, `${path}.${k}`);
  }
  (def.options ?? []).forEach((o, i) => child(o, `${path}|${i}`));
  child(def.element, `${path}[]`);
  child(def.innerType, path);
  child(def.in, `${path}<in>`);
  child(def.out, `${path}<out>`);
  child(def.left, `${path}<left>`);
  child(def.right, `${path}<right>`);
  child(def.keyType, `${path}<key>`);
  child(def.valueType, `${path}<value>`);
  (def.items ?? []).forEach((o, i) => child(o, `${path}[${i}]`));
  child(def.rest, `${path}<rest>`);
  if (def.type === 'lazy' && def.getter) child(def.getter(), `${path}<lazy>`);
  return out;
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

  it('L3: the strictness walk reaches nested objects, arrays, pipes, unions and records', () => {
    const mk = () => z.object({ a: z.string() });
    const loose = mk();
    const strict = z.object({ a: z.string() }).strict();
    expect(nonStrict(strict as unknown as Walkable, 'S')).toEqual([]);
    expect(nonStrict(loose as unknown as Walkable, 'L')).toEqual(['L']);
    const nested = z
      .object({
        list: z.array(mk()).optional(),
        pipe: z
          .string()
          .transform(() => ({ b: 1 }))
          .pipe(mk().nullable()),
        either: z.union([strict, mk()]),
        map: z.record(z.string(), mk()),
        deep: z.object({ inner: mk() }).strict(),
      })
      .strict();
    const found = nonStrict(nested as unknown as Walkable, 'N');
    expect(found).toEqual(
      expect.arrayContaining([
        'N.list[]',
        'N.pipe<out>',
        'N.either|1',
        'N.map<value>',
        'N.deep.inner',
      ]),
    );
    expect(found).toHaveLength(5);
  });
});
