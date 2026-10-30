// PUB-UI-OFFERS: the pure view logic of the publisher offers list (filter tabs, status chips, cover initials).
import { describe, expect, it } from 'vitest';
import {
  OFFER_FILTERS,
  filterCounts,
  filterHref,
  filterOffers,
  offerInitials,
  parseOfferFilter,
  statusFilter,
  statusTone,
  tabText,
} from './offers-view';

const rows = [
  { id: 'a', status: 'authorised' as const },
  { id: 'b', status: 'draft' as const },
  { id: 'c', status: 'authorised' as const },
  { id: 'd', status: 'withdrawn' as const },
];

describe('parseOfferFilter', () => {
  it('accepts the four names', () => {
    for (const f of OFFER_FILTERS) expect(parseOfferFilter(f)).toBe(f);
  });
  it('falls back to all for anything else', () => {
    for (const v of [undefined, '', 'ALL', 'authorised', 'on sale', '__proto__', 'on_sale ']) {
      expect(parseOfferFilter(v)).toBe('all');
    }
  });
  it('reads the first value of a repeated parameter', () => {
    expect(parseOfferFilter(['draft', 'withdrawn'])).toBe('draft');
    expect(parseOfferFilter([])).toBe('all');
  });
});

describe('status mapping', () => {
  it('maps a stored status to a filter and a chip tone', () => {
    expect(statusFilter('authorised')).toBe('on_sale');
    expect(statusFilter('draft')).toBe('draft');
    expect(statusFilter('withdrawn')).toBe('withdrawn');
    expect(statusTone('authorised')).toBe('good');
    expect(statusTone('draft')).toBe('warn');
    expect(statusTone('withdrawn')).toBe('neutral');
  });
});

describe('filterCounts and filterOffers', () => {
  it('counts every tab and the counts add up', () => {
    const c = filterCounts(rows);
    expect(c).toEqual({ all: 4, on_sale: 2, draft: 1, withdrawn: 1 });
    expect(c.on_sale + c.draft + c.withdrawn).toBe(c.all);
  });
  it('keeps the order of the rows it is given', () => {
    expect(filterOffers(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterOffers(rows, 'on_sale').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterOffers(rows, 'draft').map((r) => r.id)).toEqual(['b']);
    expect(filterOffers(rows, 'withdrawn').map((r) => r.id)).toEqual(['d']);
  });
  it('counts an empty list as zero everywhere', () => {
    expect(filterCounts([])).toEqual({ all: 0, on_sale: 0, draft: 0, withdrawn: 0 });
  });
});

describe('tabs', () => {
  it('writes the label with its count and a query string link', () => {
    expect(tabText('on_sale', 3)).toBe('On sale (3)');
    expect(tabText('all', 0)).toBe('All (0)');
    expect(filterHref('all')).toBe('/publisher/offers?status=all');
    expect(filterHref('withdrawn')).toBe('/publisher/offers?status=withdrawn');
  });
});

describe('offerInitials', () => {
  it('skips a leading article so the letters mean something', () => {
    expect(offerInitials('A morning walk along the old quay')).toBe('MW');
    expect(offerInitials('The tide tables')).toBe('TT');
    expect(offerInitials('Why the quayside market moved indoors')).toBe('WQ');
  });
  it('skips stop words anywhere, so the letters come from the first two significant words', () => {
    expect(offerInitials('A notebook of six working knots')).toBe('NS');
    expect(offerInitials('Notes on the history of tea in Japan')).toBe('NH');
    expect(offerInitials('Tides and moons')).toBe('TM');
    expect(offerInitials('The Quayside')).toBe('QU');
  });
  it('handles one word, only articles and no letters', () => {
    expect(offerInitials('Quayside')).toBe('QU');
    expect(offerInitials('The')).toBe('TH');
    expect(offerInitials('Of the')).toBe('OT');
    expect(offerInitials('123')).toBe('');
  });
});
