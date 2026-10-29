// DP-5b (M2, L3): the cancel page keeps its promises (static, scoped, with a way forward) and the
// disabled pack button points at its hint. Rendered or read as the page is; no server, no PayPal.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANCEL_BODY, CANCEL_WINDOW_LINE } from './lib/composite-copy';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the cancel page (M2)', () => {
  // The page is a .tsx file the unit runner does not compile (the browser run in e2e renders it); its
  // source is read here, and the copy it shows is pinned by the golden test.
  const src = read('./app/checkout/cancel/page.tsx');

  it('says what happened to this payment and what can still be done', () => {
    expect(src).toContain('{CANCEL_HEADING}');
    expect(src).toMatch(/data-testid="cancel-body"[^>]*>\{CANCEL_BODY\}/);
    expect(src).toMatch(/data-testid="cancel-window"[^>]*>\{CANCEL_WINDOW_LINE\}/);
    expect(CANCEL_WINDOW_LINE).toMatch(/window is still open/);
    expect(CANCEL_WINDOW_LINE).toMatch(/approve the other payment from the order page/);
  });

  it('claims "nothing was charged" for this payment only', () => {
    expect(CANCEL_BODY).toContain('Nothing was charged for this payment.');
    expect(CANCEL_BODY).not.toMatch(/Nothing was charged\./);
    expect(`${CANCEL_BODY} ${CANCEL_WINDOW_LINE}`).not.toMatch(/order (was|has been) cancelled/i);
  });

  it('names no window length (it would have to come from the configured window)', () => {
    expect(`${CANCEL_BODY} ${CANCEL_WINDOW_LINE}`).not.toMatch(/\d+\s*(minutes|hours|min)\b/i);
    expect(src).not.toMatch(/\d+\s*(minutes|hours|min)\b/i);
  });

  it('is static: it imports no server module and takes no id from the URL', () => {
    const code = src.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /server\/|composition|getApp|fetch\(|searchParams|params|cookies|headers/,
    );
    expect(code).not.toMatch(/'use client'/);
  });

  it('still leads somewhere: a link to the library', () => {
    expect(src).toMatch(/href="\/library"/);
  });
});

describe('the pack button hint (L3)', () => {
  const src = read('./app/discover/DiscoverForm.tsx');

  it('the disabled "Buy selected together" button is described by its hint', () => {
    const end = src.indexOf('{BUY_SELECTED}');
    const button = src.slice(src.lastIndexOf('<button', end), end);
    expect(button).toContain('disabled={picked.length < 2}');
    expect(button).toMatch(/aria-describedby=/);
    expect(button).toContain('pack-hint');
    // the hint is the element that carries that id, and it is the sentence shown beside the button
    expect(src).toMatch(
      /id="pack-hint"[^>]*>\s*Select two or more articles to buy them together\./,
    );
  });
});
