// UX-1A addendum (items 45, 46, 50, 53). The unit runner does not compile .tsx, so wording lives in
// pure helpers in lib/buyer-copy.ts and the .tsx wiring is read as text, as in ux-phase1a.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OfferPage } from '../lib/view-types';
import {
  BROWSE_EMPTY,
  BROWSE_HEADING,
  TERMS_POINTS,
  browseEntries,
  browseLinkText,
  termsPoints,
} from '../lib/buyer-copy';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const noComments = (s: string) => s.replace(/\/\/.*$/gm, '');
const css = read('../app/globals.css');

const offer = (slug: string, code: string, title: string, prices: number[]): OfferPage => ({
  offer_id: `ofr_${slug}_${code}`,
  title,
  abstract: 'x',
  publisher: 'Harbour Ledger',
  publisher_slug: slug,
  offer_code: code,
  language: 'en',
  bytes: 1024,
  currency: 'USD',
  options: prices.map((p, i) => ({
    option: i === 0 ? 'online_read' : 'keep_retrieve',
    price_minor: p,
  })),
  renegotiation_allowed: false,
  floor_minor: null,
  rights: { scope: 'personal_use', ai_scope: 'not_allowed', redistribution: false },
  on_sale: true,
});

describe('item 46: browse all when search finds nothing', () => {
  const offers = [
    offer('harbour-ledger', 'tide-tables', 'Tide Tables', [120, 40]),
    offer('harbour-ledger', 'knot-notebook', 'Knot Notebook', [450]),
  ];

  it('lists every offer with title, publisher, a from price and its offer page link', () => {
    const e = browseEntries(offers);
    expect(e.map((x) => x.title)).toEqual(['Tide Tables', 'Knot Notebook']);
    expect(e[0]!.href).toBe('/o/harbour-ledger/tide-tables');
    expect(e[0]!.publisher).toBe('Harbour Ledger');
    expect(e[0]!.price_text).toBe('from $0.40');
    expect(e[1]!.price_text).toBe('from $4.50');
  });

  it('words the link and the empty case plainly', () => {
    expect(BROWSE_HEADING).toBe('Browse all articles');
    expect(browseLinkText(2)).toBe('Browse all 2 articles');
    expect(browseLinkText(1)).toBe('Browse the 1 article');
    expect(BROWSE_EMPTY).toBe('The catalogue has no articles right now.');
  });

  it('the search page passes the catalogue and the no-match view links to the list', () => {
    const page = noComments(read('../app/discover/page.tsx'));
    expect(page).toContain('listOffers()');
    expect(page).toContain('browseEntries(');
    expect(page).toMatch(/<DiscoverForm[^>]*browse=/);
    const form = noComments(read('../app/discover/DiscoverForm.tsx'));
    expect(form).toContain('BROWSE_HEADING');
    expect(form).toContain('id="browse-all"');
    expect(form).toContain('href="#browse-all"');
    expect(form).toContain('browseLinkText(');
    expect(form).toContain('BROWSE_EMPTY');
  });
});

describe('item 50: the full terms before the tick', () => {
  it('states the facts, and the AI-use line comes from the offer rights', () => {
    const base = termsPoints().join(' ').toLowerCase();
    expect(base).toContain('personal use only');
    expect(base).toContain('no redistribution');
    expect(base).toContain('five days of access');
    expect(base).toContain('15 minutes');
    const ai = (s: 'agent_allowed' | 'review' | 'not_allowed') =>
      termsPoints({ scope: 'personal_use', ai_scope: s, redistribution: false });
    expect(ai('agent_allowed')).toHaveLength(TERMS_POINTS.length + 1);
    // F3: there is no review path in the product, so `review` says what is true.
    expect(ai('review').at(-1)).toBe('This purchase does not include use with AI tools.');
    const lines = [ai('agent_allowed'), ai('review'), ai('not_allowed')].map((p) => p.at(-1));
    expect(new Set(lines).size).toBe(3);
    expect(lines.join(' ')).not.toMatch(/charged|refund|paid| - |\u2014|\u2013/i);
  });

  it('TermsConsent renders the terms first, open, then the tick, linked by aria-describedby', () => {
    const src = noComments(read('./TermsConsent.tsx'));
    const details = src.indexOf('<details');
    const box = src.indexOf('type="checkbox"');
    expect(details).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(details);
    expect(src).toMatch(/<details[^>]*\bopen\b/);
    expect(src).toContain('aria-describedby');
    expect(src).toContain('TERMS_SUMMARY');
    expect(src).not.toMatch(/\sstyle=/);
  });

  it('the search page and the offer page both use it, and neither keeps a bare terms tick', () => {
    for (const f of [
      '../app/discover/DiscoverForm.tsx',
      '../app/o/[publisher]/[offer]/OfferFlow.tsx',
    ]) {
      const src = noComments(read(f));
      expect(src, f).toContain('<TermsConsent');
      expect(src, f).not.toMatch(/type="checkbox"\s+checked=\{terms\}/);
    }
    expect(read('../app/discover/DiscoverForm.tsx')).toContain(
      'I accept the terms of purchase for the article I choose.',
    );
    expect(read('../app/o/[publisher]/[offer]/OfferFlow.tsx')).toContain(
      'I accept the terms of this purchase.',
    );
  });
});

describe('item 45: the receipt page names the article and the publisher', () => {
  it('shows the title and publisher, not the article id', () => {
    const src = noComments(read('../app/receipts/[order]/page.tsx'));
    expect(src).toContain('buyerReceipt(');
    expect(src).toContain('l.title');
    expect(src).toContain('l.publisher');
    expect(src).not.toMatch(/<td[^>]*>\s*\{l\.article_id\}/);
    expect(src).toContain('data-testid="receipt-sha256"');
    expect(src).toContain('data-testid="receipt-version"');
  });
  it('the receipt route returns the buyer receipt', () => {
    expect(noComments(read('../app/api/receipts/[order]/route.ts'))).toContain('buyerReceipt(');
  });
});

describe('item 53: the ops order reference is whole', () => {
  it('prints the reference unsliced in a cell that does not wrap or clip, inside a scroll wrapper', () => {
    // INT-UI0: the orders table moved from /ops to /ops/money.
    const src = noComments(read('../app/ops/money/page.tsx'));
    expect(src).toContain('{o.order_ref}');
    expect(src).not.toMatch(/order_ref\s*\.\s*(slice|substring|substr)/);
    expect(src).not.toMatch(/order_ref[^}]*\.\.\./);
    expect(src).toContain('className="mono order-ref"');
    // PUB-UI-FIX3: the wrapper is the shared TableScroll (a labelled, focusable table-scroll region).
    expect(src).toContain('<TableScroll label="Latest orders">');
    expect(noComments(read('../app/publisher/pk-sales-parts.tsx'))).toMatch(
      /className="table-scroll"\s+tabIndex=\{0\}\s+role="region"\s+aria-label=\{label\}/,
    );
    expect(css).toMatch(/\.order-ref\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).not.toMatch(/\.order-ref\s*\{[^}]*(text-overflow|overflow:\s*hidden)/);
  });
});

describe('stylesheet: the new rules do not leak into the page frame (review F1)', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1]!.trim(),
    body: m[2]!,
  }));
  it('no rule whose selector list contains main sets white-space nowrap', () => {
    const bad = rules.filter(
      (r) => /(^|,)\s*main\s*(,|$)/.test(r.sel) && /white-space:\s*nowrap/.test(r.body),
    );
    expect(bad).toEqual([]);
  });
  it('the frame selector list still sets max-width, margin and padding', () => {
    const frame = rules.find(
      (r) => /(^|,)\s*main\s*(,|$)/.test(r.sel) && /max-width:\s*var\(--page-max\)/.test(r.body),
    );
    expect(frame).toBeDefined();
    expect(frame!.sel.replace(/\s+/g, ' ')).toBe('.site-header .inner, main, .site-footer');
    expect(frame!.body).toMatch(/margin:\s*0 auto/);
    expect(frame!.body).toMatch(/padding:\s*0 var\(--space\)/);
  });
  // WEB-POLISH-3: one width token for the header content, the page and the footer (880px, 1120px from 1200px).
  it('--page-max is 880px, and 1120px from 1200px, and nothing else caps the frame', () => {
    const c = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(c).toMatch(/:root\s*\{\s*--page-max:\s*880px;\s*\}/);
    expect(c).toMatch(/@media \(min-width: 1200px\)\s*\{\s*:root\s*\{[^}]*--page-max:\s*1120px;/);
    const capped = rules.filter(
      (r) =>
        /(^|,)\s*(main|\.site-footer|\.site-header \.inner)\s*(,|$)/.test(r.sel) &&
        /max-width/.test(r.body),
    );
    expect(capped.map((r) => r.sel.replace(/\s+/g, ' '))).toEqual([
      '.site-header .inner, main, .site-footer',
    ]);
  });
});

describe('search page terms carry the AI-use lines of the offers listed (review F2)', () => {
  const R = (ai: 'agent_allowed' | 'review' | 'not_allowed') =>
    ({ scope: 'personal_use', ai_scope: ai, redistribution: false }) as const;
  it('termsPoints takes several rights and prints each distinct AI line once', () => {
    const one = termsPoints([R('review'), R('review')]);
    expect(one).toHaveLength(TERMS_POINTS.length + 1);
    const two = termsPoints([R('review'), R('agent_allowed')]);
    expect(two).toHaveLength(TERMS_POINTS.length + 2);
    expect(termsPoints([])).toEqual([...TERMS_POINTS]);
  });
  it('the page passes rights to DiscoverForm and the form to TermsConsent', () => {
    expect(noComments(read('../app/discover/page.tsx'))).toMatch(/<DiscoverForm[^>]*rights=/);
    const form = noComments(read('../app/discover/DiscoverForm.tsx'));
    expect(form).toMatch(/<TermsConsent[\s\S]*?rights=\{/);
  });
});

describe('receipt fingerprint wording (review F4)', () => {
  it('says the hash covers the receipt as stored, with details not shown', () => {
    const src = read('../app/receipts/[order]/page.tsx').replace(/\s+/g, ' ');
    expect(src).toContain(
      'SHA-256 of the receipt as we stored it, which includes payment details not shown here.',
    );
    expect(src).toContain('Keep it: we can show the stored receipt was not changed.');
    expect(src).not.toContain('SHA-256 of this receipt.');
  });
});
