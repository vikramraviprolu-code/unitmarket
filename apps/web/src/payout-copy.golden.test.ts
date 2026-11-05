// POB-M1 golden: every word the payout and fee screens show. Operations: "Payouts to publishers" with its state labels and the
// fee form ("0 to 30" percent). Publisher statement and sales page: the money block. D-051: no italics, no dashes.
import { describe, expect, it, vi } from 'vitest';
import * as copy from './lib/payout-copy';

vi.mock('server-only', () => ({}));

describe('operator words', () => {
  it('names the section, the states and the columns', () => {
    expect(copy.PAYOUTS_HEADING).toBe('Payouts to publishers');
    expect(copy.PAYOUT_STATE_LABEL).toEqual({
      due: 'Due',
      sending: 'Sending',
      sent: 'Sent',
      confirmed: 'Paid out',
      failed: 'Failed',
      cancelled: 'Cancelled',
    });
    expect(copy.PAYOUT_COLUMNS).toEqual({
      publisher: 'Publisher',
      amount: 'Amount',
      state: 'State',
      sales: 'Sales',
      created: 'Created',
    });
    expect(copy.PAYOUTS_EMPTY).toBe('No payouts yet.');
  });
  it('explains in plain words when a payout is made', () => {
    expect(copy.PAYOUTS_LEDE).toBe(
      'UnitMarket pays a publisher after the access window of a sale has ended, with no refund open. One payout is for one publisher and one currency.',
    );
    expect(copy.PAYOUTS_DRYRUN_NOTE).toBe('Dry run: no money moved.');
  });
  it('the fee form says 0 to 30 percent and nothing about basis points', () => {
    expect(copy.FEE_HEADING).toBe('Fee on top');
    expect(copy.FEE_INPUT_LABEL).toBe('Fee in percent (0 to 30)');
    expect(copy.FEE_LEDE).toBe(
      'UnitMarket adds this fee to the publisher price and the customer pays it. A new rate applies to offers published from now on. Enter 0 to 30 percent.',
    );
    expect(copy.FEE_REASON_LABEL).toBe('Reason');
    expect(copy.FEE_SUBMIT).toBe('Set the fee');
    expect(copy.feeCurrentText(1000)).toBe('Current fee: 10 percent.');
    expect(copy.feeCurrentText(750)).toBe('Current fee: 7.5 percent.');
    expect(copy.FEE_NO_MFA).toBe(
      'Changing the fee needs a sign in with your authenticator code. This session has none.',
    );
    for (const s of [copy.FEE_LEDE, copy.FEE_INPUT_LABEL, copy.FEE_NO_MFA]) {
      expect(s).not.toMatch(/bps|basis/i);
    }
  });
});

describe('percentToBps', () => {
  it.each([
    ['10', 1000],
    ['7.5', 750],
    ['7.55', 755],
    ['0', 0],
    ['0.00', 0],
    ['30', 3000],
    ['30.00', 3000],
    [' 12 ', 1200],
    ['0.05', 5],
  ])('%s gives %i basis points', (text, bps) => {
    expect(copy.percentToBps(text)).toBe(bps);
  });
  it.each([
    '',
    ' ',
    '30.01',
    '31',
    '-1',
    '-0',
    '+5',
    '1e1',
    '7,5',
    '.5',
    '5.',
    '0.001',
    '10%',
    'ten',
    '1 0',
    '0x10',
    '３０',
  ])('%j is not a fee', (text) => {
    expect(copy.percentToBps(text)).toBeNull();
  });
  it('bpsToPercentText is the inverse for whole basis points', () => {
    for (const bps of [0, 5, 50, 100, 750, 755, 1000, 2999, 3000]) {
      expect(copy.percentToBps(copy.bpsToPercentText(bps))).toBe(bps);
    }
    expect(copy.bpsToPercentText(1000)).toBe('10');
    expect(copy.bpsToPercentText(750)).toBe('7.5');
    expect(copy.bpsToPercentText(5)).toBe('0.05');
  });
});

describe('publisher words', () => {
  it('uses the labels the spec names', () => {
    expect(copy.MONEY_LABEL).toEqual({
      fee: 'UnitMarket fee on top (paid by the customer)',
      owed: 'Owed to you',
      paid: 'Paid out to you',
      adjustments: 'Open adjustments (refunded after payout)',
      next: 'Next payout',
    });
    expect(copy.MONEY_SOURCE).toEqual({
      fee: 'Source: ledger fee rows minus fee reversal rows.',
      owed: 'Source: ledger payable rows minus payable reversal rows.',
      paid: 'Source: payouts that were sent or paid out.',
      adjustments:
        'Source: the publisher share of refunds booked after payout, not yet taken off a payout.',
      next: 'Source: what is owed and not yet in a payout, less the open adjustments, never below zero.',
    });
  });
  it('shows the tiles of a block in order, and the adjustments only when there are some', () => {
    const base = {
      fee_minor: 40,
      owed_minor: 360,
      paid_out_minor: 0,
      adjustment_minor: 0,
      net_minor: 360,
    };
    expect(copy.moneyTiles(base, 'USD').map((t) => [t.key, t.label, t.value])).toEqual([
      ['fee', 'UnitMarket fee on top (paid by the customer)', '$0.40'],
      ['owed', 'Owed to you', '$3.60'],
      ['paid', 'Paid out to you', '$0.00'],
      ['next', 'Next payout', '$3.60'],
    ]);
    const adj = { ...base, adjustment_minor: 90, paid_out_minor: 360, net_minor: 0 };
    expect(copy.moneyTiles(adj, 'USD').map((t) => t.key)).toEqual([
      'fee',
      'owed',
      'paid',
      'adjustments',
      'next',
    ]);
    expect(copy.moneyTiles(adj, 'USD').find((t) => t.key === 'adjustments')!.value).toBe('$0.90');
  });
});

describe('D-051 for every string', () => {
  it('has no dash, no hyphen and no italics marker anywhere', () => {
    const all: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') all.push(v);
      else if (v !== null && typeof v === 'object')
        Object.values(v as Record<string, unknown>).forEach(walk);
    };
    for (const [, v] of Object.entries(copy)) if (typeof v !== 'function') walk(v);
    all.push(copy.feeCurrentText(1000), copy.feeCurrentText(755));
    for (const t of copy.moneyTiles(
      { fee_minor: 1, owed_minor: 2, paid_out_minor: 3, adjustment_minor: 4, net_minor: 5 },
      'USD',
    )) {
      all.push(t.label, t.value, t.note ?? '');
    }
    expect(all.length).toBeGreaterThan(20);
    for (const s of all) {
      expect(s, s).not.toMatch(/[-‐-―−*_]/);
    }
  });
});
