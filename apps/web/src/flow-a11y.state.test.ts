// FIX-FLOW D8 and D10 (docs/specs/fix-flow-gate12.md): keyboard use keeps focus and is announced. The unit
// runner does not compile .tsx, so the components are read as text, as skin.state.test.ts does.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appearanceApplied } from './lib/appearance-copy';

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

describe('AppearanceControl (D8)', () => {
  const src = code('ui/AppearanceControl.tsx');
  it('never disables the radios or reloads, so focus stays where the keyboard put it', () => {
    expect(src).not.toMatch(/disabled=\{/);
    expect(src).not.toContain('location.reload');
  });
  it('applies the skin to <html> in place and announces it in a polite status region', () => {
    expect(src).toMatch(/documentElement\.setAttribute\(\s*'data-skin'/);
    expect(src).toMatch(/role="status"/);
    expect(src).toContain('appearanceApplied(');
  });
  it('the announcement names the skin and has no dash', () => {
    expect(appearanceApplied('Deep Harbour')).toBe('Appearance changed to Deep Harbour.');
    expect(appearanceApplied('Bright Market')).not.toMatch(/[‒-―−]| - |--/);
  });
});

describe('DiscoverForm focus (D10)', () => {
  const src = code('app/discover/DiscoverForm.tsx');
  it('moves focus to a results heading that can take focus', () => {
    expect(src).toContain('useRef');
    expect(src).toMatch(/\.focus\(\)/);
    expect(src).toMatch(
      /<h2[^>]*id="results"[^>]*tabIndex=\{-1\}|<h2[^>]*tabIndex=\{-1\}[^>]*id="results"/,
    );
  });
  it('shows the open order notice with a library link when the reasons say so', () => {
    expect(src).toContain('discoverNoMatchView(');
    expect(src).toContain('open_order');
  });
});

describe('the layout (D1, D11)', () => {
  const src = code('app/layout.tsx');
  it('builds the nav from lib/nav and shows the sign out control only for a signed in actor', () => {
    expect(src).toContain('navItems(');
    expect(src).toContain('<SignOutButton');
  });
});

// INT-OPS-B: the text-read check for the three new operator pages and their parts. Every input has a label,
// every table a caption or a name, every form and region a name, and the current page is marked.
describe('INT-OPS-B pages: labelled landmarks, inputs and tables', () => {
  const FILES = [
    'app/ops/money/transactions/page.tsx',
    'app/ops/controls/activity/page.tsx',
    'app/ops/controls/invariants/page.tsx',
    'ui/FilterBar.tsx',
    'ui/ops/QuickFind.tsx',
    'ui/ops/ActivityTable.tsx',
    'ui/ops/TransactionsTable.tsx',
    'ui/ops/VerifyTile.tsx',
  ];
  const named = (tag: string, src: string): string[] =>
    [...src.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => m[0]);
  it.each(FILES)('%s: nav, section and form elements have a name', (f) => {
    const src = code(f);
    for (const tag of ['nav', 'form']) {
      for (const el of named(tag, src))
        expect(el, `${f} ${tag}`).toMatch(/aria-label=|aria-labelledby=|role="search"/);
    }
    for (const el of named('section', src)) expect(el, f).toMatch(/aria-label=|aria-labelledby=/);
  });
  it.each(FILES)('%s: each input, select and textarea is labelled', (f) => {
    const src = code(f);
    const fields = ['input', 'select', 'textarea'].flatMap((t) => named(t, src));
    for (const el of fields) {
      const id = /\bid=(?:"([^"]+)"|\{([^}]+)\})/.exec(el);
      const labelled =
        /aria-label=|aria-labelledby=/.test(el) ||
        (id !== null &&
          new RegExp(
            `htmlFor=(?:"${id[1] ?? ''}"|\\{${(id[2] ?? '').replace(/[$()]/g, '\\$&')}\\})`,
          ).test(src));
      expect(labelled, `${f}: ${el}`).toBe(true);
    }
  });
  it('the Transactions and Activity tables have a caption or a name, and the pages a level one heading', () => {
    for (const f of ['ui/ops/TransactionsTable.tsx', 'ui/ops/ActivityTable.tsx']) {
      const src = code(f);
      expect(src, f).toMatch(/<caption|<table[^>]*aria-label=/);
      expect(src, f).toMatch(/<th scope="col"/);
    }
    for (const f of FILES.slice(0, 3)) expect(code(f), f).toMatch(/<PageHeader\b[^>]*title=/);
  });
  it('the filter bar names its chips list and marks nothing by colour alone', () => {
    const src = code('ui/FilterBar.tsx');
    expect(src).toMatch(/<ul[^>]*aria-label=/);
    expect(src).toMatch(/role="status"|aria-live=/);
  });
  it('quick-find results are a named region, the input says what it does, and Enter is announced', () => {
    const src = code('ui/ops/QuickFind.tsx');
    expect(src).toMatch(/<section[^>]*aria-label="Quick find results"/);
    expect(src).toMatch(/aria-live="polite"|role="status"/);
    expect(src).toMatch(/htmlFor="shell-search-input"/);
  });
  it('the verify tile says its result in words and has the run link as a real link', () => {
    const src = code('ui/ops/VerifyTile.tsx');
    expect(src).toMatch(/<a [^>]*href=\{tile\.runHref\}|<Link[^>]*href=\{tile\.runHref\}/);
    expect(src).toMatch(/role="status"|aria-live=/);
  });
});

// INT-OPS-A: the new operator pages and parts each have one level one heading, named landmarks and no bare inputs.
describe('INT-OPS-A pages: named landmarks and headings', () => {
  const FILES = [
    'app/ops/alerts/page.tsx',
    'app/ops/alerts/[id]/page.tsx',
    'app/ops/buyers/cases/page.tsx',
    'app/ops/buyers/cases/[id]/page.tsx',
    'app/ops/money/problems/page.tsx',
    'app/ops/money/orders/[ref]/page.tsx',
    'ui/ops/HealthLights.tsx',
    'ui/ops/AlertList.tsx',
    'ui/ops/AlertDetail.tsx',
    'ui/ops/CaseCard.tsx',
    'ui/shell/AlertBell.tsx',
  ];
  it.each(FILES)('%s: nav, section and form elements have a name', (f) => {
    const src = code(f);
    for (const tag of ['nav', 'section', 'form']) {
      for (const el of [...src.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => m[0]))
        expect(el, `${f} ${el}`).toMatch(/aria-label=|aria-labelledby=/);
    }
    expect(src).not.toMatch(/<input\b(?![^>]*(aria-label=|id=))/);
  });
  it.each(FILES.filter((f) => f.startsWith('app/')))('%s has one level one heading', (f) => {
    expect(code(f).match(/<h1\b/g) ?? []).toHaveLength(1);
  });
  it('the health lights say their state in words, not by colour alone', () => {
    expect(code('ui/ops/HealthLights.tsx')).toMatch(/\.word/);
  });
});
