// PUB-UI-SALES: the view-model of the publisher sales page (S4) and statement page (S5): which chip tone a
// status or ledger entry gets, and the tile figures worked out from one totals row. Pure.
import { describe, expect, it } from 'vitest';
import {
  HOW_MADE_SUMMARY,
  STATEMENT_FILE_SUMMARY,
  envTone,
  ledgerKindTone,
  totalsTiles,
  unitStatusTone,
} from './publisher-sales-view';

const NO_DASH = /[–—]|\s-\s/;

describe('unitStatusTone', () => {
  it('Paid is good, refunded and held units warn, reversed is bad, mismatch warns', () => {
    expect(unitStatusTone('captured_verified')).toBe('good');
    expect(unitStatusTone('refunded')).toBe('warn');
    expect(unitStatusTone('partially_refunded')).toBe('warn');
    expect(unitStatusTone('reversal_suspected')).toBe('warn');
    expect(unitStatusTone('mismatch')).toBe('warn');
    expect(unitStatusTone('reversed')).toBe('bad');
  });
  it('the units not counted as sales and any unknown word stay calm', () => {
    expect(unitStatusTone('pending')).toBe('info');
    expect(unitStatusTone('declined')).toBe('bad');
    expect(unitStatusTone('expected')).toBe('neutral');
    expect(unitStatusTone('something_new')).toBe('neutral');
  });
});

describe('ledgerKindTone and envTone', () => {
  it('a sale is good, a refund warns, a reversal is bad, a fee is neutral', () => {
    expect(ledgerKindTone('sale')).toBe('good');
    expect(ledgerKindTone('refund')).toBe('warn');
    expect(ledgerKindTone('reversal')).toBe('bad');
    expect(ledgerKindTone('paypal_fee')).toBe('neutral');
    expect(ledgerKindTone('other')).toBe('neutral');
  });
  it('the environment chip tone follows the stored environment', () => {
    expect(envTone('sandbox')).toBe('info');
    expect(envTone('dryrun')).toBe('warn');
  });
});

describe('totalsTiles', () => {
  const row = {
    currency: 'USD',
    environment: 'sandbox' as const,
    units_paid: 3,
    gross_minor: 1500,
    refunds_minor: 300,
    reversals_minor: 200,
    net_minor: 1000,
    paypal_fee_minor: 45,
  };

  it('gives Paid units, Gross, Refunds and Net, in that order, from the stored figures', () => {
    const t = totalsTiles(row);
    expect(t.map((x) => x.key)).toEqual(['units', 'gross', 'refunds', 'net']);
    expect(t.map((x) => x.label)).toEqual(['Paid units', 'Gross', 'Refunds', 'Net']);
    expect(t[0]!.value).toBe('3');
    expect(t[1]!.value).toBe('$15.00');
    expect(t[2]!.value).toBe('$3.00');
  });

  it('the net tile is the stored net: the PayPal fee is a note beside it and is never subtracted', () => {
    const net = totalsTiles(row).find((x) => x.key === 'net')!;
    expect(net.value).toBe('$10.00');
    expect(net.note).toBe('PayPal fee: $0.45. Not subtracted.');
    const noFee = totalsTiles({ ...row, paypal_fee_minor: null }).find((x) => x.key === 'net')!;
    expect(noFee.value).toBe('$10.00');
    expect(noFee.note).toBe('PayPal fee: Not reported. Not subtracted.');
  });

  it('a dry run reports no fee even when a value is stored', () => {
    const net = totalsTiles({ ...row, environment: 'dryrun' }).find((x) => x.key === 'net')!;
    expect(net.note).toBe('PayPal fee: Not reported. Not subtracted.');
    expect(net.value).toBe('$10.00');
  });

  it('reversals ride on the refunds tile so every stored sum stays visible', () => {
    const refunds = totalsTiles(row).find((x) => x.key === 'refunds')!;
    expect(refunds.note).toBe('Reversals: $2.00');
  });

  it('keeps the currency of the row', () => {
    const t = totalsTiles({ ...row, currency: 'JPY', gross_minor: 1500 });
    expect(t.find((x) => x.key === 'gross')!.value).toMatch(/1,500/);
  });
});

describe('words', () => {
  it('the two new summaries have no dash', () => {
    expect(HOW_MADE_SUMMARY).toBe('How these figures are made');
    expect(STATEMENT_FILE_SUMMARY).toBe('About the download');
    for (const s of [HOW_MADE_SUMMARY, STATEMENT_FILE_SUMMARY]) expect(s).not.toMatch(NO_DASH);
  });
});
