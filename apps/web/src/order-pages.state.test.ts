// DP-5b (M2, L3): the cancel page keeps its promises (static, scoped, with a way forward) and the
// disabled pack button points at its hint. Rendered or read as the page is; no server, no PayPal.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANCEL_BODY, CANCEL_BODY_NO_REF, CANCEL_WINDOW_LINE } from './lib/composite-copy';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the cancel page (M2, H1)', () => {
  // The page is a .tsx file the unit runner does not compile (the browser run in e2e renders it); its
  // source is read here. What it shows for a ref is decided by lib/cancel-view.ts (own unit test) and
  // the copy is pinned by the golden test.
  const src = read('./app/checkout/cancel/page.tsx');
  const code = src.replace(/\/\/.*$/gm, '');

  it('renders the body, the window sentence and the link from the view of the ref', () => {
    expect(code).toContain('{CANCEL_HEADING}');
    expect(code).toMatch(/cancelView\(/);
    expect(code).toMatch(/data-testid="cancel-body"[^>]*>\{[a-z.]*body\}/);
    expect(code).toMatch(/data-testid="cancel-window"[^>]*>\{[a-z.]*window_line\}/);
    expect(code).toMatch(/data-testid="cancel-back"/);
    expect(code).toMatch(/href=\{[a-z.]*back_href\}/);
    expect(code).toContain('{CANCEL_BACK_LINK}');
  });

  it('reads ref from the search params and only builds a link from the validated view', () => {
    expect(code).toMatch(/searchParams/);
    expect(code).toMatch(/q\[['"]ref['"]\]|\.ref\b/);
    // no href is built from the raw param in the page
    expect(code).not.toMatch(/checkout\/return/);
    expect(code).not.toMatch(/href=\{`/);
  });

  it('is free of API calls, database access and state changes: no server, composition or db import', () => {
    for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      expect(m[1], m[0]).not.toMatch(/server|composition|@umsbx\/db|access|session/);
    }
    expect(code).not.toMatch(/getApp|app\(\)|fetch\(|cookies|headers|redirect|notFound|useEffect/);
    expect(code).not.toMatch(/'use client'/);
    const view = read('./lib/cancel-view.ts').replace(/\/\/.*$/gm, '');
    for (const m of view.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      expect(m[1], m[0]).not.toMatch(/server|composition|@umsbx\/db|access|session/);
    }
  });

  it('claims "nothing was charged" for this payment only, and names no window length', () => {
    for (const t of [CANCEL_BODY, CANCEL_BODY_NO_REF]) {
      expect(t).toContain('Nothing was charged for this payment.');
      expect(t).not.toMatch(/Nothing was charged\./);
    }
    const all = `${CANCEL_BODY} ${CANCEL_BODY_NO_REF} ${CANCEL_WINDOW_LINE}`;
    expect(all).not.toMatch(/\d+\s*(minutes|hours|min)\b/i);
    expect(all).not.toMatch(/the other payment from the order page/);
    expect(src).not.toMatch(/\d+\s*(minutes|hours|min)\b/i);
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
