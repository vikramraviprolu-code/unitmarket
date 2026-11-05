// POB-M1: the payout contract. Constants, the six payout states, the new ledger kinds and the id prefix.
import { describe, expect, it } from 'vitest';
import {
  FEE_BPS_MAX,
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
    expect(IdPrefixSchema.options).toHaveLength(35);
  });
});
