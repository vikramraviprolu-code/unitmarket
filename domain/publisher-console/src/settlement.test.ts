// PUB-C: the settlement wording is derived from stored facts only, and "paid" words are used only
// where PayPal pays the publisher directly (proposal 6: never "paid out" unless PayPal paid the publisher).
import { describe, expect, it } from 'vitest';
import { COMMISSION_LINE, settlementMode } from './settlement';
import type { SettlementFacts } from './settlement';

const facts = (over: Partial<SettlementFacts> = {}): SettlementFacts => ({
  merchant_id: 'MERCHANT0001A',
  payee_shared: false,
  environment: 'sandbox',
  own_merchant_id: 'OWNERMERCH001',
  ...over,
});

describe('settlementMode', () => {
  it('dry run: no money moved, whatever the payee says', () => {
    for (const over of [
      {},
      { payee_shared: true },
      { merchant_id: null },
      { merchant_id: 'OWNERMERCH001' },
    ]) {
      const s = settlementMode(facts({ environment: 'dryrun', ...over }));
      expect(s).toEqual({ mode: 'dryrun', sentence: 'Dry run: no money moved.' });
    }
  });

  it('owner account: the shared flag, or a merchant id equal to the owner id', () => {
    const sentence =
      "Collected into the UnitMarket team's sandbox test account. Not paid out: sandbox demo; UnitMarket has no payout mechanism.";
    expect(settlementMode(facts({ payee_shared: true }))).toEqual({
      mode: 'owner_account',
      sentence,
    });
    expect(settlementMode(facts({ merchant_id: 'OWNERMERCH001' }))).toEqual({
      mode: 'owner_account',
      sentence,
    });
  });

  it('direct: own verified account that is neither shared nor the owner account', () => {
    expect(settlementMode(facts())).toEqual({
      mode: 'direct',
      sentence: 'Paid by PayPal directly into your own sandbox account.',
    });
    // With no owner id configured nothing can equal it.
    expect(settlementMode(facts({ own_merchant_id: null })).mode).toBe('direct');
  });

  it('not set: no merchant id stored', () => {
    for (const over of [{}, { payee_shared: true }, { own_merchant_id: null }]) {
      expect(settlementMode(facts({ merchant_id: null, ...over }))).toEqual({
        mode: 'not_set',
        sentence: 'No PayPal account is linked yet.',
      });
    }
  });

  it('only the direct mode says the publisher was paid; no other mode says "paid out" without "not"', () => {
    const all = [
      settlementMode(facts({ environment: 'dryrun' })),
      settlementMode(facts({ payee_shared: true })),
      settlementMode(facts()),
      settlementMode(facts({ merchant_id: null })),
    ];
    for (const s of all) {
      if (s.mode === 'direct') expect(s.sentence).toMatch(/^Paid by PayPal directly/);
      else expect(s.sentence.replace(/Not paid out/g, '')).not.toMatch(/paid/i);
    }
  });

  it('has no dash characters and no italics', () => {
    for (const s of [
      settlementMode(facts({ environment: 'dryrun' })),
      settlementMode(facts({ payee_shared: true })),
      settlementMode(facts()),
      settlementMode(facts({ merchant_id: null })),
    ]) {
      expect(s.sentence).not.toMatch(/[‐-―]|--| - /);
    }
  });
});

describe('commission line', () => {
  it('is the fixed sentence', () => {
    expect(COMMISSION_LINE).toBe(
      'No commission in this demo; planned 20 percent, not implemented.',
    );
  });
});
