// POB-M1: the payout contract. Constants, the six payout states, the new ledger kinds and the id prefix.
import { describe, expect, it } from 'vitest';
import {
  FEE_BPS_MAX,
  FeeBpsSchema,
  IdPrefixSchema,
  LedgerEntryInputSchema,
  LedgerKindSchema,
  PAYOUT_MAX_MINOR,
  PAYOUT_RETRY_AFTER_MS,
  PayoutStateSchema,
  SYNTHETIC_LINK_VERIFIER,
  isSyntheticPayee,
} from './index';

describe('payout contract (POB-M1)', () => {
  it('fixes the ceilings the spec names', () => {
    expect(FEE_BPS_MAX).toBe(3000);
    expect(PAYOUT_MAX_MINOR).toBe(100_000_000);
    expect(PAYOUT_RETRY_AFTER_MS).toBe(24 * 3_600_000);
  });
  it('FeeBpsSchema is a whole number from 0 to 3000', () => {
    for (const ok of [0, 1, 750, 1000, 3000]) expect(FeeBpsSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      -1,
      3001,
      10_000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1000',
      null,
      undefined,
    ]) {
      expect(FeeBpsSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('has six payout states, sending between due and sent', () => {
    expect([...PayoutStateSchema.options]).toEqual([
      'due',
      'sending',
      'sent',
      'confirmed',
      'failed',
      'cancelled',
    ]);
  });
  it('adds five ledger kinds after the six old ones, in that order', () => {
    expect([...LedgerKindSchema.options]).toEqual([
      'sale',
      'paypal_fee',
      'platform_fee',
      'refund',
      'reversal',
      'commission_reversal',
      'fee',
      'payable',
      'fee_reversal',
      'payable_reversal',
      'payout_adjustment',
    ]);
    const input = {
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      kind: 'payable',
      amount: { currency: 'USD', minor: 360 },
      refund_id: null,
      ref_entry_id: null,
    };
    expect(LedgerEntryInputSchema.safeParse(input).success).toBe(true);
  });
  it('has the pay id prefix', () => {
    expect(IdPrefixSchema.safeParse('pay').success).toBe(true);
    expect(IdPrefixSchema.options).toHaveLength(36);
  });
});

describe('the synthetic payee (POB-DEMOLINK)', () => {
  it('the marker cannot be an operator id: operator ids are opr_ plus lower case letters, digits and underscores', () => {
    expect(SYNTHETIC_LINK_VERIFIER).toBe('seed:synthetic');
    expect(SYNTHETIC_LINK_VERIFIER).not.toMatch(/^opr_[a-z][a-z0-9_]{0,31}$/);
  });
  it('an address on the reserved .invalid domain is synthetic, in any case and with stray space', () => {
    for (const e of ['demo-harbour-ledger@payee.invalid', 'A@B.INVALID', ' x@y.z.invalid '])
      expect(isSyntheticPayee(e, null)).toBe(true);
  });
  it('the marker alone is enough, and nothing else is', () => {
    expect(isSyntheticPayee('someone@example.test', SYNTHETIC_LINK_VERIFIER)).toBe(true);
    for (const e of [
      'someone@example.test',
      'a@invalid.example',
      'a@notinvalid',
      'a@x.invalidx',
      '',
    ])
      expect(isSyntheticPayee(e, 'opr_vikram')).toBe(false);
    expect(isSyntheticPayee('someone@example.test', null)).toBe(false);
  });
});
