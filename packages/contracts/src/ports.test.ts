import { describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  ContentHeadSchema,
  IdPrefixSchema,
  LogEventSchema,
  ModelPurposeSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  SecretSchema,
  SwitchNameSchema,
} from './ports';

describe('ports schemas', () => {
  it('IdPrefix lists the 31 prefixes (26 plus key and evt, API-W0, plus wsb, wdl and pas, API-C)', () => {
    expect(IdPrefixSchema.options).toHaveLength(31);
    expect(IdPrefixSchema.safeParse('ord').success).toBe(true);
    expect(IdPrefixSchema.safeParse('xyz').success).toBe(false);
  });
  it('SwitchName has the six switches', () => {
    expect([...SwitchNameSchema.options].sort()).toEqual([
      'ai_enabled',
      'checkout_enabled',
      'paypal_outbound',
      'refunds_enabled',
      'unlock_enabled',
      'webhook_enabled',
    ]);
  });
  it('ModelPurpose has two values', () => {
    expect([...ModelPurposeSchema.options]).toEqual(['brief_parse', 'pack_compose']);
  });
  it('ModelResponse is a discriminated union', () => {
    expect(
      ModelResponseSchema.safeParse({ kind: 'ok', output: {}, input_tokens: 1, output_tokens: 2 })
        .success,
    ).toBe(true);
    expect(ModelResponseSchema.safeParse({ kind: 'error', reason: 'x' }).success).toBe(true);
    expect(ModelResponseSchema.safeParse({ kind: 'error', reason: 'x', extra: 1 }).success).toBe(
      false,
    );
    expect(
      ModelResponseSchema.safeParse({ kind: 'ok', output: {}, input_tokens: -1, output_tokens: 2 })
        .success,
    ).toBe(false);
  });
  it('ModelRequest, ContentHead, LogEvent, AuditEntry validate', () => {
    expect(
      ModelRequestSchema.safeParse({ purpose: 'brief_parse', system: 's', input: 1 }).success,
    ).toBe(true);
    expect(
      ContentHeadSchema.safeParse({ bytes: 1, sha256: 'a'.repeat(64), mime: 'a/b' }).success,
    ).toBe(true);
    expect(
      ContentHeadSchema.safeParse({ bytes: 1.5, sha256: 'a'.repeat(64), mime: 'a/b' }).success,
    ).toBe(false);
    expect(
      LogEventSchema.safeParse({
        msg: 'm',
        level: 'info',
        fields: { a: 1, b: 'x', c: null, d: true },
      }).success,
    ).toBe(true);
    expect(
      LogEventSchema.safeParse({ msg: 'm', level: 'info', fields: { a: { nested: 1 } } }).success,
    ).toBe(false);
    expect(
      AuditEntrySchema.safeParse({
        actor: { kind: 'system' },
        action: 'a',
        target: null,
        reason: null,
        detail: {},
      }).success,
    ).toBe(true);
  });
  it('Secret guard accepts only objects with reveal()', () => {
    expect(
      SecretSchema.safeParse({
        reveal: () => 'x',
        toString: () => '[redacted]',
        toJSON: () => '[redacted]',
      }).success,
    ).toBe(true);
    expect(SecretSchema.safeParse('plain').success).toBe(false);
    expect(SecretSchema.safeParse({}).success).toBe(false);
  });
});
