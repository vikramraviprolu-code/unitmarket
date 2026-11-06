import { describe, expect, it } from 'vitest';
import { LedgerEntryInputSchema, LedgerEntrySchema, LedgerKindSchema } from './ledger';

const input = {
  unit_id: 'unt_1',
  capture_id: 'CAP1',
  kind: 'sale',
  amount: { currency: 'USD', minor: 500 },
  refund_id: null,
  ref_entry_id: null,
};
describe('ledger', () => {
  it('LedgerEntryInput and LedgerEntry', () => {
    expect(LedgerKindSchema.options).toHaveLength(11); // POB-M1 added fee, payable, fee_reversal, payable_reversal, payout_adjustment
    expect(LedgerEntryInputSchema.safeParse(input).success).toBe(true);
    expect(LedgerEntryInputSchema.safeParse({ ...input, kind: 'tip' }).success).toBe(false);
    expect(
      LedgerEntryInputSchema.safeParse({ ...input, amount: { currency: 'USD', minor: -5 } })
        .success,
    ).toBe(false);
    const entry = {
      ...input,
      id: 'led_1',
      created_at: '2026-10-21T10:00:00Z',
      environment: 'dryrun',
    };
    expect(LedgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(LedgerEntrySchema.safeParse({ ...entry, environment: 'live' }).success).toBe(false);
    expect(LedgerEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
  });
});
