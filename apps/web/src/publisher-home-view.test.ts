// PUB-UI-HOME: the view rules of the publisher home: which block the tiles show, and the since items.
import { describe, expect, it } from 'vitest';
import { primaryBlock, sinceItems } from './lib/publisher-home-copy';

const block = (currency: string, environment: 'dryrun' | 'sandbox') => ({
  currency,
  environment,
  units_paid: 1,
  refunds_minor: 0,
  reversals_minor: 0,
  net_minor: 100,
});

describe('primaryBlock', () => {
  it('shows no block and no note when there are no rows', () => {
    expect(primaryBlock([], 'dryrun')).toEqual({ block: null, others: 0 });
  });
  it('prefers the block of the app environment and counts the rest', () => {
    const blocks = [block('USD', 'sandbox'), block('USD', 'dryrun'), block('EUR', 'dryrun')];
    const r = primaryBlock(blocks, 'dryrun');
    expect(r.block).toBe(blocks[1]);
    expect(r.others).toBe(2);
  });
  it('falls back to the first block when none is of the app environment', () => {
    const blocks = [block('USD', 'sandbox')];
    expect(primaryBlock(blocks, 'dryrun')).toEqual({ block: blocks[0], others: 0 });
  });
});

describe('sinceItems', () => {
  it('has no item for a zero count and keeps the fixed order', () => {
    expect(
      sinceItems({ new_sales: 0, refunds: 0, operator_offer_changes: 0, payee_decisions: 0 }),
    ).toEqual([]);
    const items = sinceItems({
      new_sales: 1,
      refunds: 2,
      operator_offer_changes: 1,
      payee_decisions: 1,
    });
    expect(items.map((i) => i.kind)).toEqual(['sale', 'refund', 'offer', 'payee']);
    expect(items[0]?.text).toBe('1 new sale.');
    expect(items[1]?.text).toBe('2 refunds.');
  });
  it('gives every item a chip with words', () => {
    for (const i of sinceItems({
      new_sales: 1,
      refunds: 1,
      operator_offer_changes: 1,
      payee_decisions: 1,
    }))
      expect(i.chip.label.length).toBeGreaterThan(0);
  });
});
