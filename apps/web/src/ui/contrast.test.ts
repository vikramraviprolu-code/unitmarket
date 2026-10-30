// SKIN-A: WCAG 2.2 AA contrast for the pairs of each skin, read from globals.css (docs/specs/skin-a-system.md).
// SKIN-B: the harbour values are the Deep Harbour overrides of skin-harbour.css on top of globals.css; the pairs are unchanged.
// Each skin is one fixed palette, so every pair is checked once per skin. A failing token is changed
// minimally in the stylesheet and listed in the hand-back; this file is not loosened.
import { describe, expect, it } from 'vitest';
import { SKINS, contrast, readGlobalsCss, mergedTokenMap } from '../skin-css-test-support';

const css = readGlobalsCss();

// [foreground token, background token, minimum ratio]
const PAIRS: Array<[string, string, number]> = [
  ['text', 'bg', 7],
  ['text', 'surface', 7],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'surface-2', 4.5],
  ['accent-ink', 'accent', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'accent-soft', 4.5],
  // SKIN-B1: the tag text on the hot accent (tags only, never a button).
  ['hot-ink', 'hot', 4.5],
  ['good', 'good-soft', 4.5],
  ['good', 'surface', 4.5],
  ['warn', 'warn-soft', 4.5],
  ['warn', 'surface', 4.5],
  ['bad', 'bad-soft', 4.5],
  ['bad', 'surface', 4.5],
  ['line', 'surface', 3],
  ['line', 'bg', 3],
  ['focus', 'bg', 3],
  ['focus', 'surface', 3],
  // The top bar: text and links at 4.5, the focus ring at 3.
  ['header-ink', 'header-bg', 4.5],
  ['header-link', 'header-bg', 4.5],
  ['header-link', 'header-hover', 4.5],
  ['header-focus', 'header-bg', 3],
  // Publisher cover tiles: initials on the hue.
  ...[0, 1, 2, 3, 4, 5].map((n): [string, string, number] => [`h${n}i`, `h${n}b`, 4.5]),
];

describe.each(SKINS)('contrast, %s skin', (skin) => {
  const t = mergedTokenMap(skin);
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, min) => {
    const a = t[`--${fg}`];
    const b = t[`--${bg}`];
    expect(a, `--${fg} is defined`).toBeDefined();
    expect(b, `--${bg} is defined`).toBeDefined();
    expect(contrast(a!, b!)).toBeGreaterThanOrEqual(min);
  });
});

describe('both skins declare the same tokens', () => {
  it('the token names match one for one', () => {
    expect(Object.keys(mergedTokenMap('harbour')).sort()).toEqual(
      Object.keys(mergedTokenMap('market')).sort(),
    );
  });
});

describe('the stylesheet follows the skin, not the browser preference', () => {
  it('has no prefers-color-scheme block (decision 39: a visitor who prefers dark chooses Deep Harbour)', () => {
    expect(css).not.toContain('prefers-color-scheme');
  });
});
