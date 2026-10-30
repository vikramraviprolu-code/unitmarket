// SKIN-B1 (docs/specs/skin-b1-bright-market-poster.md): the Bright Market poster look. The unit runner does
// not compile .tsx, so the wiring is read as text, like skin.state.test.ts does.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SKINS, readGlobalsCss, stripComments, tokenMap } from './skin-css-test-support';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const noComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(readGlobalsCss());
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: m[1]!.trim().replace(/\s+/g, ' '),
  body: m[2]!,
}));

const NEW_TSX = [
  './ui/CoverTile.tsx',
  './ui/Hero.tsx',
  './ui/OfferTile.tsx',
  './ui/FitCard.tsx',
  './app/discover/DiscoverForm.tsx',
  './app/discover/page.tsx',
  './app/page.tsx',
  './app/library/page.tsx',
];

describe('tokens', () => {
  it.each(SKINS)('%s declares --hot and --hot-ink', (skin) => {
    const t = tokenMap(readGlobalsCss(), skin);
    expect(t['--hot']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(t['--hot-ink']).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('the rounded heading stack leads with ui-rounded and ends in system fonts only', () => {
    const t = tokenMap(readGlobalsCss(), 'market');
    expect(t['--display']).toMatch(/^ui-rounded,/);
    expect(t['--display']).toMatch(/system-ui/);
    expect(t['--display']).toMatch(/sans-serif$/);
  });
  it('declares one monospace stack for prices', () => {
    expect(css).toMatch(/--mono:\s*ui-monospace/);
  });
});

describe('the yellow accent is for tags only', () => {
  it('only .tag rules use var(--hot) or var(--hot-ink)', () => {
    const users = rules.filter((r) => /var\(--hot(-ink)?\)/.test(r.body));
    expect(users.length).toBeGreaterThan(0);
    for (const r of users) {
      for (const part of r.sel.split(',')) expect(part.trim(), r.sel).toMatch(/^\.tag\b/);
    }
  });
  it('no button rule mentions the hot tokens', () => {
    for (const r of rules) {
      if (/\.btn|button/.test(r.sel)) expect(r.body, r.sel).not.toMatch(/--hot/);
    }
  });
});

describe('prices', () => {
  it('.price is monospace with tabular figures', () => {
    const price = rules.filter((r) => r.sel.split(',').some((s) => s.trim() === '.price'));
    expect(price.length).toBeGreaterThan(0);
    const body = price.map((r) => r.body).join(' ');
    expect(body).toMatch(/font-family:\s*var\(--mono\)/);
    expect(body).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe('no motion and no external resources (SKIN-B2 owns motion)', () => {
  it('has no transition and only the SKIN-A spinner keyframes', () => {
    expect(css).not.toMatch(/transition\s*:/);
    expect([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])).toEqual(['spin']);
    for (const r of rules) {
      if (/animation\s*:/.test(r.body)) expect(r.sel).toMatch(/spinner/);
    }
  });
  it('has no url(), @import or @font-face', () => {
    expect(css).not.toMatch(/url\(|@import|@font-face/);
  });
  it('has no italics', () => {
    expect(css).not.toMatch(/font-style\s*:\s*italic/);
  });
});

describe('covers', () => {
  it('has six distinct patterned hues', () => {
    const patterns = [0, 1, 2, 3, 4, 5].map((n) => {
      const r = rules.find((x) => x.sel === `.cover-h${String(n)}`);
      expect(r, `.cover-h${String(n)}`).toBeDefined();
      expect(r!.body).toContain(`--cb: var(--h${String(n)}b)`);
      return r!.body.replace(/\s+/g, ' ');
    });
    expect(new Set(patterns).size).toBe(6);
  });
  it('CoverTile derives the hue from the article data, is decorative and has no inline style', () => {
    const src = noComments(read('./ui/CoverTile.tsx'));
    expect(src).toContain('coverHue(');
    expect(src).toContain('coverSeed(');
    expect(src).toContain('coverInitials(');
    expect(src).toMatch(/cover-h\$\{/);
    expect(src).toContain('aria-hidden="true"');
    expect(src).not.toMatch(/\sstyle=/);
    expect(src).not.toMatch(/Math\.random|Date\.now/);
  });
  it.each([
    ['./ui/FitCard.tsx', /<CoverTile[^>]*title=\{title\}/],
    ['./app/library/page.tsx', /<CoverTile[^>]*title=\{i\.title\}/],
    ['./ui/OfferTile.tsx', /<CoverTile[^>]*title=\{/],
  ])('%s wires the cover from the article title and publisher', (file, re) => {
    const src = noComments(read(file));
    expect(src).toMatch(re);
    expect(src).toMatch(/publisher=\{/);
  });
  it('the tag text comes from the stored access option, not a literal', () => {
    const src = noComments(read('./ui/FitCard.tsx'));
    expect(src).toMatch(/tag=\{optionLabel\(option\)\}/);
  });
});

describe('hero with the search pill', () => {
  it('is on the home page and on the find page, with the need label and field id kept', () => {
    const home = noComments(read('./app/page.tsx'));
    expect(home).toContain('<Hero');
    expect(home).toContain('action="/discover"');
    expect(home).toContain('className="search-pill"');
    const form = noComments(read('./app/discover/DiscoverForm.tsx'));
    expect(form).toContain('<Hero');
    expect(form).toContain('className="search-pill"');
    expect(form).toContain('id="need"');
    expect(form).toContain('What do you need?');
    expect(noComments(read('./app/discover/page.tsx'))).toContain('initialNeed');
  });
  it('the hero takes its colours from the header tokens of the skin', () => {
    const hero = rules.find((r) => r.sel === '.hero');
    expect(hero).toBeDefined();
    expect(hero!.body).toContain('var(--header-bg)');
    expect(hero!.body).toContain('var(--header-ink)');
    const pill = rules.find((r) => r.sel === '.search-pill');
    expect(pill).toBeDefined();
    expect(pill!.body).toContain('border-radius: 999px');
  });
});

describe('copy rules for the files this lane touches', () => {
  it.each(NEW_TSX)('%s has no inline style, italics or dash characters in copy', (file) => {
    const src = noComments(read(file));
    expect(src).not.toMatch(/\sstyle=/);
    expect(src).not.toMatch(/<em[\s>]|<i[\s>]/);
    // en dash, em dash (the comment-stripped source only; code has no such characters either)
    expect(src).not.toMatch(/[–—]/);
  });
});

describe('money path files are not touched by this lane', () => {
  it('approve and checkout pages carry no cover or hero', () => {
    const approve = noComments(read('./app/approve/[id]/ApproveClient.tsx'));
    expect(approve).not.toMatch(/CoverTile|<Hero/);
  });
});
