// CAT-2.6 golden: every word the popular requests, the proposal card lines and the publisher demand card show.
// D-051: no italics, no dashes in the copy. The band text itself ("5-9") is data from the domain.
import { describe, expect, it } from 'vitest';
import * as copy from './lib/demand-copy';

describe('CAT-2.6 words', () => {
  it('pins the static words', () => {
    expect(copy.POPULAR_HEADING).toBe('Popular requests');
    expect(copy.POPULAR_HINT).toBe(
      'Asked for by 5 or more buyers in the last 30 days. Tap one to fill the box.',
    );
    expect(copy.DEMAND_CARD_HEADING).toBe('What buyers ask for');
    expect(copy.DEMAND_CARD_EMPTY).toBe('No requests from 5 or more buyers yet.');
    expect(copy.DEMAND_CARD_NOTE).toBe(
      'Bands from buyers who asked in the last 30 days. No buyer is named.',
    );
  });

  it('pins the variable lines', () => {
    expect(copy.demandLine('harbour', '5-9', 3)).toBe(
      'harbour: 5-9 buyers asked; 3 of your offers match',
    );
    expect(copy.demandLine('sunset', '50+', 0)).toBe(
      'sunset: 50+ buyers asked; 0 of your offers match',
    );
    expect(copy.collectionLine('harbour', 1000, true)).toBe(
      'From the harbour collection (1000 photos)',
    );
    expect(copy.collectionLine('other', 1, true)).toBe('From the other collection (1 photo)');
    expect(copy.collectionLine('local', 12, false)).toBe('From the local collection (12 items)');
    expect(copy.collectionLine('local', 1, false)).toBe('From the local collection (1 item)');
    expect(copy.copiesHiddenLine(9)).toBe('9 copies hidden');
    expect(copy.copiesHiddenLine(1)).toBe('1 copy hidden');
  });

  it('uses no dash characters and no italics markers', () => {
    const all = [
      copy.POPULAR_HEADING,
      copy.POPULAR_HINT,
      copy.DEMAND_CARD_HEADING,
      copy.DEMAND_CARD_EMPTY,
      copy.DEMAND_CARD_NOTE,
      copy.collectionLine('x', 2, true),
      copy.collectionLine('x', 2, false),
      copy.copiesHiddenLine(2),
    ].join('\n');
    expect(all).not.toMatch(/[‒-―]|\*|_/);
  });
});
