import { describe, expect, it } from 'vitest';
import {
  CurrencyCodeSchema,
  EnvironmentLabelSchema,
  IdSchema,
  IsoUtcSchema,
  MinorUnitsSchema,
  MoneySchema,
  Sha256HexSchema,
} from './primitives';

const rejects = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(s.safeParse(v).success).toBe(false);
const accepts = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(s.safeParse(v).success).toBe(true);

describe('IdSchema', () => {
  it('id rejects control, zero-width, edge whitespace, 201 chars', () => {
    accepts(IdSchema, 'ord_01HZX');
    accepts(IdSchema, 'a'.repeat(200));
    rejects(IdSchema, '');
    rejects(IdSchema, 'a'.repeat(201));
    rejects(IdSchema, ' ord_1');
    rejects(IdSchema, 'ord_1 ');
    rejects(IdSchema, 'ord\u0000_1');
    rejects(IdSchema, 'ord\n1');
    rejects(IdSchema, 'ord\u007f1');
    rejects(IdSchema, 'ord​1');
    rejects(IdSchema, 'ord‍1');
    rejects(IdSchema, 'ord﻿1');
    rejects(IdSchema, 5);
  });
  it('L2: id rejects bidi controls, word joiner, C1 controls and unicode edge whitespace', () => {
    for (const cp of [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2060, 0x0085,
      0x009f, 0x200b, 0xfeff,
    ]) {
      rejects(IdSchema, `a${String.fromCodePoint(cp)}b`);
    }
    rejects(IdSchema, '\u00a0x');
    rejects(IdSchema, 'x\u3000');
    accepts(IdSchema, 'é ü');
  });
  it('allows inner whitespace', () => {
    accepts(IdSchema, 'a b');
  });
});

describe('IsoUtcSchema', () => {
  it('IsoUtc accepts Z only; rejects +00:00', () => {
    accepts(IsoUtcSchema, '2026-10-21T10:00:00Z');
    accepts(IsoUtcSchema, '2026-10-21T10:00:00.123Z');
    rejects(IsoUtcSchema, '2026-10-21T10:00:00+00:00');
    rejects(IsoUtcSchema, '2026-10-21T10:00:00');
    rejects(IsoUtcSchema, '2026-10-21');
  });
});

describe('Money', () => {
  it('Money rejects floats, negatives, lowercase currency', () => {
    accepts(MoneySchema, { currency: 'USD', minor: 0 });
    accepts(MoneySchema, { currency: 'USD', minor: 1999 });
    rejects(MoneySchema, { currency: 'USD', minor: 19.99 });
    rejects(MoneySchema, { currency: 'USD', minor: -1 });
    rejects(MoneySchema, { currency: 'usd', minor: 1 });
    rejects(MoneySchema, { currency: 'USDX', minor: 1 });
    rejects(MoneySchema, { currency: 'USD', minor: 1, extra: 1 });
    rejects(MinorUnitsSchema, Number.NaN);
    rejects(MinorUnitsSchema, Number.POSITIVE_INFINITY);
    rejects(CurrencyCodeSchema, 'US');
  });
});

describe('Sha256Hex and EnvironmentLabel', () => {
  it('Sha256Hex is 64 lowercase hex', () => {
    accepts(Sha256HexSchema, 'a'.repeat(64));
    rejects(Sha256HexSchema, 'A'.repeat(64));
    rejects(Sha256HexSchema, 'a'.repeat(63));
  });
  it('EnvironmentLabel has exactly dryrun and sandbox', () => {
    expect([...EnvironmentLabelSchema.options].sort()).toEqual(['dryrun', 'sandbox']);
    rejects(EnvironmentLabelSchema, 'live');
    rejects(EnvironmentLabelSchema, 'production');
    rejects(EnvironmentLabelSchema, 'simulation');
  });
});
