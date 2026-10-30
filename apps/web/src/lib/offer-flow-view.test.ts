// GATEFIX2 items 3, 5 and 7: the words and decisions of the buyer offer page, pure.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NOT_ON_SALE_HEADING,
  UNPAID_ORDER_HEADING,
  UNPAID_ORDER_LINK,
  noMatchView,
  offerOnSale,
  refusedQuoteView,
} from './offer-flow-view';
import { historyStatusText } from './offer-copy';

const NO_DASH = /[‒-―−]| - |--/;

describe('noMatchView', () => {
  it('already_owned says library, and only that', () => {
    const v = noMatchView('already_owned', undefined);
    expect(v.text).toMatch(/in your library/);
    expect(v.link).toBeNull();
  });
  it('unpaid_order says unpaid order and links to the order', () => {
    const v = noMatchView('unpaid_order', 'ord_abc');
    expect(v.heading).toBe(UNPAID_ORDER_HEADING);
    expect(v.text).toMatch(/You have an unpaid order for this article/);
    expect(v.text).not.toMatch(/in your library/);
    expect(v.link).toEqual({ href: '/orders/ord_abc', text: UNPAID_ORDER_LINK });
  });
  it('unpaid_order without a ref still says it and points to My library', () => {
    const v = noMatchView('unpaid_order', undefined);
    expect(v.link).toEqual({ href: '/library', text: 'Open My library' });
  });
  it('the order ref is encoded into the link', () => {
    expect(noMatchView('unpaid_order', 'a/b c').link?.href).toBe('/orders/a%2Fb%20c');
  });
  it('other reasons keep their usual line, and an unknown one a plain fallback', () => {
    expect(noMatchView('withdrawn', undefined).text).toMatch(/withdrawn/);
    expect(noMatchView('something_new', undefined).text).toMatch(/no match/i);
  });
  it('no dash', () => {
    for (const r of ['already_owned', 'unpaid_order', 'withdrawn', 'above_ceiling'])
      expect(JSON.stringify(noMatchView(r, 'x'))).not.toMatch(NO_DASH);
  });
});

describe('refusedQuoteView (item 5)', () => {
  it('an expired or changed quote hides the card and gives one message', () => {
    for (const code of ['quote_expired', 'offer_changed']) {
      const v = refusedQuoteView(code, 'server words');
      expect(v.hideQuote).toBe(true);
      expect(v.title).toBe('This price is no longer available');
      expect(v.body).toMatch(/Show my price/);
      expect(v.body).not.toMatch(/expired expired/);
    }
  });
  it('another failure keeps the card and the server words', () => {
    const v = refusedQuoteView('consent_missing', 'Please accept the terms to continue.');
    expect(v.hideQuote).toBe(false);
    expect(v.body).toBe('Please accept the terms to continue.');
  });
  it('the offer flow uses it and never titles a refused review "Could not get a price"', () => {
    const src = readFileSync(
      new URL('../app/o/[publisher]/[offer]/OfferFlow.tsx', import.meta.url),
      'utf8',
    ).replace(/\/\/.*$/gm, '');
    expect(src).toContain('refusedQuoteView(');
    expect(src).toContain('noMatchView(');
    expect(src).toMatch(/offer\.on_sale/);
  });
});

describe('offerOnSale (item 7)', () => {
  const base = {
    status: 'authorised',
    superseded_by: null,
    publisher_status: 'active',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: null,
    now_ms: Date.parse('2026-10-30T12:00:00.000Z'),
  };
  it('authorised, current, active publisher, inside validity: on sale', () => {
    expect(offerOnSale(base)).toBe(true);
  });
  it('withdrawn, draft, superseded, suspended publisher, not yet valid, expired: not on sale', () => {
    expect(offerOnSale({ ...base, status: 'withdrawn' })).toBe(false);
    expect(offerOnSale({ ...base, status: 'draft' })).toBe(false);
    expect(offerOnSale({ ...base, superseded_by: 'v2' })).toBe(false);
    expect(offerOnSale({ ...base, publisher_status: 'suspended' })).toBe(false);
    expect(offerOnSale({ ...base, publisher_status: 'applied' })).toBe(false);
    expect(offerOnSale({ ...base, valid_from: '2027-01-01T00:00:00.000Z' })).toBe(false);
    expect(offerOnSale({ ...base, valid_until: '2026-10-30T12:00:00.000Z' })).toBe(false);
  });
  it('the heading says Not on sale and the page shows no prices for it', () => {
    expect(NOT_ON_SALE_HEADING).toBe('Not on sale');
    const src = readFileSync(
      new URL('../app/o/[publisher]/[offer]/OfferFlow.tsx', import.meta.url),
      'utf8',
    );
    expect(src).toContain('NOT_ON_SALE_HEADING');
  });
});

describe('historyStatusText (item 7)', () => {
  it('only the newest authorised version is On sale; older ones are replaced', () => {
    expect(historyStatusText('authorised', true)).toBe('On sale');
    expect(historyStatusText('authorised', false)).toBe('Replaced by a newer version');
  });
  it('withdrawn and draft read the same whatever their place', () => {
    for (const newest of [true, false]) {
      expect(historyStatusText('withdrawn', newest)).toBe('Withdrawn');
      expect(historyStatusText('draft', newest)).toBe('Draft');
    }
  });
});
