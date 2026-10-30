// SKIN-A: the cover tile hue is a fixed function of the publisher slug (style spec, "Cover tile hues"):
// the sum of the character codes, modulo 6. No randomness (lint S6), so a tile never changes colour.
import { describe, expect, it } from 'vitest';
import { coverHue } from './cover';

describe('coverHue', () => {
  it('is the character-code sum modulo 6', () => {
    expect(coverHue('harbour-ledger')).toBe(5);
    expect(coverHue('tide-tables')).toBe(4);
    expect(coverHue('a')).toBe(1);
    expect(coverHue('')).toBe(0);
  });
  it('is stable and always one of the six hues', () => {
    for (const slug of ['quayside', 'knot-notebook', 'x'.repeat(500)]) {
      expect(coverHue(slug)).toBe(coverHue(slug));
      expect([0, 1, 2, 3, 4, 5]).toContain(coverHue(slug));
    }
  });
});
