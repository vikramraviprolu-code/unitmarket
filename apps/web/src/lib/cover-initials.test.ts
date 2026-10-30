// SKIN-B1: the cover tile of an article card is generated from the article's own data (publisher name and
// title). Pure helpers, no randomness (lint S6): the same article always gets the same cover.
import { describe, expect, it } from 'vitest';
import { coverHue, coverInitials, coverSeed } from './cover';

describe('coverInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(coverInitials('Harbour Ledger')).toBe('HL');
    expect(coverInitials('the tide tables co')).toBe('TT');
  });
  it('takes the first two letters of a single word', () => {
    expect(coverInitials('Quayside')).toBe('QU');
    expect(coverInitials('x')).toBe('X');
  });
  it('ignores punctuation and gives an empty string when there are no letters', () => {
    expect(coverInitials('  -- Knot & Notebook --')).toBe('KN');
    expect(coverInitials('')).toBe('');
    expect(coverInitials('123 ...')).toBe('');
  });
});

describe('coverSeed', () => {
  it('joins publisher and title so two articles of one publisher can differ', () => {
    expect(coverSeed('Harbour Ledger', 'Tide tables')).toBe(
      coverSeed('Harbour Ledger', 'Tide tables'),
    );
    expect(coverSeed('Harbour Ledger', 'Tide tables')).not.toBe(
      coverSeed('Harbour Ledger', 'Ferry timetable'),
    );
  });
  it('feeds coverHue with a stable hue in 0 to 5', () => {
    const hues = new Set(
      [
        'Tide tables',
        'Ferry timetable',
        'Knot notebook',
        'Quay map',
        'Lighthouse log',
        'Tidal gates',
      ].map((t) => coverHue(coverSeed('Harbour Ledger', t))),
    );
    for (const h of hues) expect([0, 1, 2, 3, 4, 5]).toContain(h);
    expect(hues.size).toBeGreaterThanOrEqual(3);
  });
});
