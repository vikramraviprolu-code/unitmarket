// INT-GA / GA.1: the rule parser. Thirty plain-words phrases become the expected TxnQuery string map with no model
// call: dates from an injected `now` (UTC), amounts with their currency ("p" is GBP, "$" is USD), status, refund
// and case words, and seller names from the context. A port spy proves the model is never asked when the rules
// place every word.
import { describe, expect, it, vi } from 'vitest';
import type { ModelPort } from '@umsbx/contracts';
import { assistQuery, parseRules } from './index';
import type { AssistContext } from './index';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SELLERS = ['Harbour Ledger', 'Quayside Gazette'];
const buyer: AssistContext = { role: 'buyer', sellers: SELLERS };
const operator: AssistContext = { role: 'operator', sellers: SELLERS };
const publisher: AssistContext = { role: 'publisher', sellers: ['Harbour Ledger'] };

const TODAY = { from: '2026-11-05', to: '2026-11-05' };
const CASES: [string, AssistContext, Record<string, string>][] = [
  ['orders from today', buyer, TODAY],
  ['what did I buy yesterday', buyer, { from: '2026-11-04', to: '2026-11-04' }],
  ['purchases last week', buyer, { from: '2026-10-29', to: '2026-11-05' }],
  ['sales this month', buyer, { from: '2026-11-01', to: '2026-11-05' }],
  ['since 1 Nov', buyer, { from: '2026-11-01' }],
  ['orders over $5', buyer, { min_minor: '500', currency: 'USD' }],
  ['under 50p', buyer, { max_minor: '50', currency: 'GBP' }],
  ['between £2 and £10', buyer, { min_minor: '200', max_minor: '1000', currency: 'GBP' }],
  ['more than €1.50', buyer, { min_minor: '150', currency: 'EUR' }],
  ['less than 75 cents', buyer, { max_minor: '75', currency: 'USD' }],
  ['frozen orders', buyer, { status: 'attention' }],
  ['failed payments', buyer, { status: 'failed' }],
  ['declined or abandoned', buyer, { status: 'failed' }],
  ['paid or refunded orders', buyer, { status: 'paid,refunded' }],
  ['partly refunded purchases', buyer, { status: 'part_refunded' }],
  ['orders in progress', buyer, { status: 'in_progress' }],
  ['orders that need attention', operator, { status: 'attention' }],
  ['refund requested', buyer, { refund: 'requested' }],
  ['partial refund', buyer, { refund: 'partial' }],
  ['orders with a full refund', buyer, { refund: 'full' }],
  ['orders with an open case', operator, { case: 'open' }],
  ['resolved cases', operator, { case: 'resolved' }],
  ['from Harbour Ledger', buyer, { seller: 'Harbour Ledger' }],
  [
    'quayside gazette orders over $1 today',
    buyer,
    { seller: 'Quayside Gazette', min_minor: '100', currency: 'USD', ...TODAY },
  ],
  ['failed orders since 1 November', buyer, { status: 'failed', from: '2026-11-01' }],
  [
    'paid this month under £3',
    buyer,
    { status: 'paid', from: '2026-11-01', to: '2026-11-05', max_minor: '300', currency: 'GBP' },
  ],
  ['orders with no refund yesterday', buyer, { refund: 'none', from: '2026-11-04', to: '2026-11-04' }],
  ['last 3 days', buyer, { from: '2026-11-02', to: '2026-11-05' }],
  ['last month', operator, { from: '2026-10-01', to: '2026-10-31' }],
  ['my sales from Harbour Ledger since 1 Nov', publisher, { from: '2026-11-01' }],
];

describe('GA.1 thirty rule-only phrases', () => {
  it('there are thirty', () => {
    expect(CASES).toHaveLength(30);
  });

  const complete = vi.fn<ModelPort['complete']>(async () => ({ kind: 'error', reason: 'spy' }));
  const port: ModelPort = { model_id: 'spy', complete };

  it.each(CASES)('%s', async (text, ctx, chips) => {
    const rules = parseRules(text, NOW, ctx);
    expect(rules.rest).toBe('');
    expect(rules.chips).toEqual(chips);
    const r = await assistQuery(text, NOW, ctx, port);
    expect(r.chips).toEqual(chips);
    expect(r.dropped).toEqual([]);
  });

  it('the port spy was never called', () => {
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('dates are UTC and come from the injected now', () => {
  it('"since 1 Nov" on 5 Nov is this year', () => {
    expect(parseRules('since 1 Nov', NOW, buyer).chips).toEqual({ from: '2026-11-01' });
  });
  it('"since 1 Nov" on 30 Oct is last year', () => {
    const oct30 = new Date('2026-10-30T23:59:59.000Z');
    expect(parseRules('since 1 Nov', oct30, buyer).chips).toEqual({ from: '2025-11-01' });
  });
  it('"since 1 Nov" on 1 Nov itself is that day', () => {
    const nov1 = new Date('2026-11-01T00:00:00.000Z');
    expect(parseRules('since Nov 1', nov1, buyer).chips).toEqual({ from: '2026-11-01' });
  });
  it('"today" just before midnight UTC is still that UTC day', () => {
    const late = new Date('2026-11-05T23:59:59.999Z');
    expect(parseRules('today', late, buyer).chips).toEqual(TODAY);
  });
  it('an impossible day is not placed', () => {
    expect(parseRules('since 31 Feb', NOW, buyer).chips).toEqual({});
  });
});

describe('amounts', () => {
  it('"50p" sets GBP and 50 minor units', () => {
    expect(parseRules('over 50p', NOW, buyer).chips).toEqual({ min_minor: '50', currency: 'GBP' });
  });
  it('"$5" sets USD and 500 minor units', () => {
    expect(parseRules('under $5', NOW, buyer).chips).toEqual({ max_minor: '500', currency: 'USD' });
  });
  it('"£1.5" is 150 pence', () => {
    expect(parseRules('at least £1.5', NOW, buyer).chips).toEqual({
      min_minor: '150',
      currency: 'GBP',
    });
  });
  it('two currencies in one phrase keep the first; the other amount is dropped, not mixed', () => {
    const r = parseRules('over $1 and under 90p', NOW, buyer);
    expect(r.chips).toEqual({ min_minor: '100', currency: 'USD' });
    expect(r.dropped).toEqual(['max_minor']);
  });
});

describe('what the rules cannot place stays in rest, and only that', () => {
  it('a word the rules do not know is the rest', () => {
    const r = parseRules('stuck orders today', NOW, buyer);
    expect(r.chips).toEqual(TODAY);
    expect(r.rest).toBe('stuck orders');
  });
  it('only filler words left is an empty rest', () => {
    expect(parseRules('show me all my orders please', NOW, buyer).rest).toBe('');
  });
  it('an empty or blank text is nothing', () => {
    expect(parseRules('   ', NOW, buyer)).toEqual({ chips: {}, rest: '', dropped: [] });
  });
  it('a text over the limit is cut, never refused', () => {
    const r = parseRules(`${'today '.repeat(200)}`, NOW, buyer);
    expect(r.chips).toEqual(TODAY);
  });
});

describe('seller names', () => {
  it('a buyer gets the catalogue name as written in the list', () => {
    expect(parseRules('harbour ledger', NOW, buyer).chips).toEqual({ seller: 'Harbour Ledger' });
  });
  it('a seller naming itself gets no chip (its scope is itself) and nothing dropped', () => {
    expect(parseRules('Harbour Ledger', NOW, publisher)).toEqual({
      chips: {},
      rest: '',
      dropped: [],
    });
  });
  it('a name only inside another word is not a match', () => {
    expect(parseRules('harbour ledgers', NOW, buyer).chips).toEqual({});
  });
});
