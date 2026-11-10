// UX-1A: copy and CSS fixes on non-money pages. The unit runner does not compile .tsx (see
// order-pages.state.test.ts), so the wording lives in pure helpers in lib/buyer-copy.ts, which these
// tests call, and the .tsx wiring and the stylesheet are read as text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS_DAYS } from '../lib/format';
import type { FitDimension } from '@umsbx/contracts';
import {
  TERMS_POINTS,
  TERMS_SUMMARY,
  WHY_THIS_FIT,
  accessDaysLine,
  priceLine,
  splitFitRows,
  windowUntilLine,
} from '../lib/buyer-copy';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('../app/globals.css');
const meterSrc = read('./WindowMeter.tsx');
const fitSrc = read('./FitCard.tsx');
const formSrc = read('../app/discover/DiscoverForm.tsx');
const noComments = (s: string) => s.replace(/\/\/.*$/gm, '');

describe('U1 library card: one statement of the time left', () => {
  it('words the end of the window as one sentence, by option', () => {
    expect(windowUntilLine('online_read', '2026-11-03 16:50 UTC')).toBe(
      'Access until 2026-11-03 16:50 UTC',
    );
    expect(windowUntilLine('keep_retrieve', '2026-11-03 16:50 UTC')).toBe(
      'Download until 2026-11-03 16:50 UTC',
    );
    expect(windowUntilLine(undefined, '2026-11-03 16:50 UTC')).toBe(
      'Access until 2026-11-03 16:50 UTC',
    );
  });

  it('WindowMeter drops the bold days line, keeps the date, the bar and the test id', () => {
    const src = noComments(meterSrc);
    expect(src).not.toMatch(/days? left/i);
    expect(src).not.toContain('<strong');
    expect(src).toContain('windowUntilLine(');
    expect(src).toContain('data-testid="window-meter"');
    expect(src).toContain('className="meter-bar"');
    expect(src).toContain('days used');
    expect(src).toContain(
      'Your access window starts when payment is confirmed and the content is ready.',
    );
  });
});

describe('U2 focus ring', () => {
  it('removes the outline on main and keeps the 3px outline on :focus-visible', () => {
    expect(css).toMatch(/main:focus\s*\{\s*outline:\s*none;\s*\}/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
  });
});

describe('U3 terms where they are accepted', () => {
  it('states the four facts', () => {
    expect(TERMS_SUMMARY).toBe('What the terms say');
    const text = TERMS_POINTS.join(' ').toLowerCase();
    expect(text).toContain('personal use only');
    expect(text).toContain('no redistribution');
    expect(text).toContain(`${DEFAULT_ACCESS_DAYS} days of access`);
    expect(text).toContain('when payment is confirmed');
    expect(text).toContain('price');
    expect(text).toContain('15 minutes');
  });

  it('keeps clear of the words D-051 reserves', () => {
    expect([TERMS_SUMMARY, ...TERMS_POINTS].join(' ')).not.toMatch(/charged|refund|paid/i);
  });

  // Changed by the addendum (item 50): the terms are open and BEFORE the tick, through TermsConsent. The
  // earlier wording of this test wanted a closed <details> under the tick.
  it('DiscoverForm shows them through TermsConsent; tick label and default unchanged', () => {
    const src = noComments(formSrc);
    expect(src).toContain('<TermsConsent');
    expect(src).toContain('useState(false)');
    expect(src).toContain('I accept the terms of purchase for the article I choose.');
    const terms = noComments(read('./TermsConsent.tsx'));
    expect(terms).toContain('TERMS_SUMMARY');
    expect(terms).toContain('termsPoints(');
  });
});

describe('U4 fit card', () => {
  const dim = (
    key: FitDimension['key'],
    level: FitDimension['level'],
    evidence = '',
  ): FitDimension => ({ key, label: key, level, basis: 'keyword_overlap', evidence });

  it('price line reads "$1.20 · Read online", never "for read online"', () => {
    expect(priceLine('$1.20', 'online_read')).toBe('$1.20 · Read online');
    expect(priceLine('$1.20', 'keep_retrieve')).toBe('$1.20 · Download and keep');
    expect(priceLine('$1.20', 'online_read')).not.toMatch(/ for /);
  });

  it('puts the days under the price line', () => {
    // BR-3: the platform default is 7 days (D-096); a sale's own days come from its frozen terms.
    expect(accessDaysLine('online_read')).toBe('7 days to read');
    expect(accessDaysLine('keep_retrieve')).toBe('7 days to download your copy');
    expect(accessDaysLine('online_read', 14)).toBe('14 days to read');
    expect(accessDaysLine('keep_retrieve', 1)).toBe('1 day to download your copy');
  });

  it('splits rows: real assessments stay visible, "not assessed" rows go to the details', () => {
    const rows = [
      dim('topic', 2, 'matches tide'),
      dim('budget', 3),
      dim('access', null),
      dim('language', null),
      dim('recency', 0, 'old'),
    ];
    const { assessed, notAssessed } = splitFitRows(rows);
    expect(assessed.map((d) => d.key)).toEqual(['topic', 'budget', 'recency']);
    expect(notAssessed.map((d) => d.key)).toEqual(['access', 'language']);
    expect(splitFitRows([dim('topic', 1)]).notAssessed).toEqual([]);
  });

  it('FitCard wires a closed "Why this fit" details, the new price line, and keeps the band', () => {
    const src = noComments(fitSrc);
    expect(WHY_THIS_FIT).toBe('Why this fit');
    expect(src).toContain('<details');
    expect(src).toContain('<summary');
    expect(src).toContain('WHY_THIS_FIT');
    expect(src).not.toMatch(/<details[^>]*\bopen\b/);
    expect(src).toContain('splitFitRows(');
    expect(src).toContain('priceLine(');
    expect(src).toContain('accessDaysLine(');
    expect(src).not.toMatch(/ for \{/);
    expect(src).toContain('card.band');
    expect(src).toContain('data-testid="fit-card"');
  });

  it('the stylesheet reflows the fit rows below 760px so the text takes its own line', () => {
    const block = css.match(/@media \(max-width: 7[56]\dpx\)\s*\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('.fit-row');
    expect(block![1]).toMatch(/\.fit-text\s*\{[^}]*grid-column:\s*2 \/ -1/);
  });
});

describe('no inline style is added (the CSP forbids it)', () => {
  it('FitCard and DiscoverForm carry no style attribute', () => {
    expect(fitSrc).not.toMatch(/\sstyle=/);
    expect(formSrc).not.toMatch(/\sstyle=/);
  });
});
