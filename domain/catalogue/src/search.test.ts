// API-A (A0): the plain catalogue text search. Pure functions over offers already read from the
// catalogue; no database, no clock, no randomness. Ranking: word overlap with `q` (more first), then
// the lowest price, then the offer id. Only authorised offers are ever returned.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { needWords, searchOffers, type SearchCandidate } from './search';

const c = (
  id: string,
  title: string,
  price: number,
  over: Partial<SearchCandidate> = {},
): SearchCandidate => ({
  offer_id: id,
  title,
  abstract: '',
  publisher_slug: 'harbour-ledger',
  status: 'authorised',
  min_price_minor: price,
  ...over,
});

const ids = (xs: readonly SearchCandidate[]) => xs.map((x) => x.offer_id);

describe('provenance header', () => {
  it('search.ts starts with the SBX origin header naming the simulation file and sha', () => {
    const text = readFileSync(fileURLToPath(new URL('./search.ts', import.meta.url)), 'utf8');
    // The origin name is split so this test file does not itself name the simulation repository.
    const origin = ['AIC_Hackathon', 'UnitMarket'].join('_');
    expect(text.split('\n')[0]).toBe(
      `// Origin: ${origin}@a99204b:packages/core/catalogue/search.ts. Adapted; owned by SBX.`,
    );
  });
  it('search.ts imports nothing from the simulation', () => {
    const text = readFileSync(fileURLToPath(new URL('./search.ts', import.meta.url)), 'utf8');
    expect(text).not.toMatch(/@unitmarket\/|@unitmarket-sim\/|simulation\//);
  });
});

describe('needWords', () => {
  it('lowercases, splits on non letters, drops words under three characters, counts each once', () => {
    expect(needWords('Tide TIDE, tables: a to be 2026!')).toEqual(['2026', 'tables', 'tide']);
  });
  it('keeps letters beyond ASCII', () => {
    expect(needWords('Hafen Gezeiten über')).toEqual(['gezeiten', 'hafen', 'über']);
  });
  it('an empty or all short text has no words', () => {
    expect(needWords('')).toEqual([]);
    expect(needWords('a an of')).toEqual([]);
  });
});

describe('searchOffers: ranking', () => {
  it('more word overlap ranks first, whatever the price', () => {
    const out = searchOffers(
      [
        c('ofr_a', 'Tide tables for the harbour', 900),
        c('ofr_b', 'Harbour fees', 100),
        c('ofr_c', 'Ferry timetables', 50),
      ],
      { q: 'tide tables harbour' },
    );
    expect(ids(out)).toEqual(['ofr_a', 'ofr_b']);
  });
  it('equal overlap: the lower price first, then the offer id', () => {
    const out = searchOffers(
      [c('ofr_z', 'Tide notes', 300), c('ofr_y', 'Tide notes', 100), c('ofr_x', 'Tide notes', 100)],
      { q: 'tide' },
    );
    expect(ids(out)).toEqual(['ofr_x', 'ofr_y', 'ofr_z']);
  });
  it('the abstract counts as text too', () => {
    const out = searchOffers([c('ofr_a', 'Notes', 10, { abstract: 'monthly tide data' })], {
      q: 'tide',
    });
    expect(ids(out)).toEqual(['ofr_a']);
  });
  it('an offer with no word in common is not returned when q has words', () => {
    expect(searchOffers([c('ofr_a', 'Ferry timetables', 10)], { q: 'tide' })).toEqual([]);
  });
  it('is deterministic: the same input in another order gives the same output', () => {
    const rows = [c('ofr_c', 'Tide', 5), c('ofr_a', 'Tide', 5), c('ofr_b', 'Tide data tide', 9)];
    const a = ids(searchOffers(rows, { q: 'tide data' }));
    const b = ids(searchOffers([...rows].reverse(), { q: 'tide data' }));
    expect(a).toEqual(b);
    expect(a).toEqual(['ofr_b', 'ofr_a', 'ofr_c']);
  });
});

describe('searchOffers: empty q and filters', () => {
  const rows = [
    c('ofr_c', 'Gamma', 300, { publisher_slug: 'quayside-gazette' }),
    c('ofr_a', 'Alpha', 100),
    c('ofr_b', 'Beta', 100),
  ];
  it('empty q returns every authorised offer in price order, then id', () => {
    expect(ids(searchOffers(rows, {}))).toEqual(['ofr_a', 'ofr_b', 'ofr_c']);
    expect(ids(searchOffers(rows, { q: '' }))).toEqual(['ofr_a', 'ofr_b', 'ofr_c']);
  });
  it('a q of only short words counts as empty', () => {
    expect(ids(searchOffers(rows, { q: 'a to' }))).toEqual(['ofr_a', 'ofr_b', 'ofr_c']);
  });
  it('publisher filters by slug', () => {
    expect(ids(searchOffers(rows, { publisher: 'quayside-gazette' }))).toEqual(['ofr_c']);
  });
  it('max_price_minor keeps offers at or under it', () => {
    expect(ids(searchOffers(rows, { max_price_minor: 100 }))).toEqual(['ofr_a', 'ofr_b']);
    expect(ids(searchOffers(rows, { max_price_minor: 99 }))).toEqual([]);
  });
  it('filters and q combine', () => {
    expect(ids(searchOffers(rows, { q: 'gamma alpha', publisher: 'harbour-ledger' }))).toEqual([
      'ofr_a',
    ]);
  });
});

describe('searchOffers: only authorised offers', () => {
  it('a withdrawn, superseded or draft offer is never returned, even on a perfect match', () => {
    const rows = [
      c('ofr_w', 'Tide tables', 1, { status: 'withdrawn' }),
      c('ofr_s', 'Tide tables', 1, { status: 'superseded' }),
      c('ofr_d', 'Tide tables', 1, { status: 'draft' }),
      c('ofr_ok', 'Tide tables', 500),
    ];
    expect(ids(searchOffers(rows, { q: 'tide tables' }))).toEqual(['ofr_ok']);
    expect(ids(searchOffers(rows, {}))).toEqual(['ofr_ok']);
  });
  it('returns the caller objects with their extra fields', () => {
    const row = { ...c('ofr_a', 'Tide', 5), extra: 'kept' };
    expect(searchOffers([row], { q: 'tide' })[0]).toBe(row);
  });
  it('does not change the input array', () => {
    const rows = [c('ofr_b', 'Tide', 9), c('ofr_a', 'Tide', 1)];
    const copy = [...rows];
    searchOffers(rows, { q: 'tide' });
    expect(rows).toEqual(copy);
  });
});
