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
