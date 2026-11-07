// PUB-C: the settlement wording is derived from stored facts only, and "paid" words are used only
// where PayPal pays the publisher directly (proposal 6: never "paid out" unless PayPal paid the publisher).
import { describe, expect, it } from 'vitest';
import {
  COMMISSION_LINE,
  NOTHING_SOLD_SENTENCE,
  PAYEE_DIRECT_SENTENCE,
  blockSettlement,
  payeeSettlement,
  settlementMode,
} from './settlement';
import type { BlockFacts, SettlementFacts } from './settlement';

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
      "In this sandbox demo every payment is received in the UnitMarket team's one test account. Nothing is paid out to the publisher.";
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
      else expect(s.sentence.replace(/Nothing is paid out/g, '')).not.toMatch(/paid/i);
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

const block = (over: Partial<BlockFacts> = {}): BlockFacts => ({
  environment: 'sandbox',
  payees: ['OWNERMERCH001'],
  own_merchant_id: 'OWNERMERCH001',
  current_merchant_id: 'MERCHANT0001A',
  payee_shared: false,
  ...over,
});

describe('blockSettlement (SETTLE-A: per block, from the payees stored on its units)', () => {
  it('a sale into the owner account stays owner account after the publisher switched payee', () => {
    const s = blockSettlement(block({ current_merchant_id: 'NEWPAYEE0001A' }));
    expect(s.mode).toBe('owner_account');
    expect(s.sentence).toMatch(/one test account/);
    expect(s.sentence).not.toMatch(/^Paid by PayPal/);
  });

  it('a stored payee equal to the current payee is direct, unless that payee is flagged shared', () => {
    const p = { payees: ['MERCHANT0001A', 'MERCHANT0001A'] };
    expect(blockSettlement(block(p)).mode).toBe('direct');
    expect(blockSettlement(block({ ...p, payee_shared: true })).mode).toBe('owner_account');
  });

  it('more than one distinct payee is mixed and never says direct', () => {
    for (const payees of [
      ['OWNERMERCH001', 'MERCHANT0001A'],
      ['MERCHANT0001A', 'MERCHANT0009Z'],
      ['MERCHANT0001A', 'MERCHANT0001A', 'OWNERMERCH001'],
    ]) {
      const s = blockSettlement(block({ payees }));
      expect(s.mode, payees.join()).toBe('mixed');
      expect(s.sentence).not.toMatch(/paid/i);
    }
  });

  it('a dry run block moved no money, whatever the payees say', () => {
    expect(blockSettlement(block({ environment: 'dryrun', payees: ['MERCHANT0001A'] })).mode).toBe(
      'dryrun',
    );
  });
});

describe('payeeSettlement (SETTLE-A: the account as it is now, for S1, S6 and S7)', () => {
  it('says new sales, not paid sales, in the direct mode, and is the shared sentence otherwise', () => {
    expect(payeeSettlement(facts())).toEqual({ mode: 'direct', sentence: PAYEE_DIRECT_SENTENCE });
    expect(PAYEE_DIRECT_SENTENCE).toMatch(/^New sales are paid/);
    expect(payeeSettlement(facts({ payee_shared: true }))).toEqual(
      settlementMode(facts({ payee_shared: true })),
    );
    expect(NOTHING_SOLD_SENTENCE).toBe('Nothing sold yet.');
  });
});

describe('commission line', () => {
  it('is the fixed sentence', () => {
    expect(COMMISSION_LINE).toBe(
      'A platform fee of 10 percent of the publisher price is added to the price shown. The publisher does not pay it.',
    );
  });
});
