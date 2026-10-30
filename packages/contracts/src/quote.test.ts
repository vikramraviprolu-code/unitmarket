import { describe, expect, it } from 'vitest';
import { NoMatchReasonSchema, NoMatchSchema, QuoteSchema } from './quote';

describe('quote', () => {
  it('Quote and NoMatch', () => {
    const q = {
      kind: 'quote',
      quote_id: 'quo_1',
      offer_id: 'ofr_1',
      offer_version: '1',
      option: 'keep_retrieve',
      price: { currency: 'USD', minor: 300 },
      corridor_id: 'us-usd',
      expires_at: '2026-10-21T10:00:00Z',
      source: 'direct',
    };
    expect(QuoteSchema.safeParse(q).success).toBe(true);
    expect(QuoteSchema.safeParse({ ...q, source: 'email' }).success).toBe(false);
    expect(NoMatchSchema.safeParse({ kind: 'no_match', reason: 'above_ceiling' }).success).toBe(
      true,
    );
    expect(NoMatchSchema.safeParse({ kind: 'no_match', reason: 'because' }).success).toBe(false);
    expect(NoMatchReasonSchema.options).toHaveLength(8); // GATEFIX2: unpaid_order added
  });
});
