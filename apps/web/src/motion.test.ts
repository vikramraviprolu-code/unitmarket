// SKIN-B (docs/specs/skin-b-harbour-motion.md): the Deep Harbour skin and the shippable motion set.
// The unit runner does not compile .tsx and has no CSS parser (D-008), so the stylesheets and the client
// components are read as text. The rules come from docs/design/motion-research-2026-10-30.md part 3:
// every animation sits inside a no-preference block, only transform and opacity move, nothing near money moves,
// and the approval page is still.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  readGlobalsCss,
  readHarbourCss,
  readMotionCss,
  stripComments,
} from './skin-css-test-support';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const noComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const NO_PREF = '@media (prefers-reduced-motion: no-preference)';

/** The text between the braces of every block that starts with `header`, brace matched. */
function blocksOf(css: string, header: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(header, from);
    if (at < 0) return out;
    const open = css.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i + 1;
  }
}

/** The stylesheet with every no-preference block cut out: what applies to everyone. */
function outsideNoPreference(css: string): string {
  let rest = css;
  for (const inner of blocksOf(css, NO_PREF)) rest = rest.replace(inner, '');
  return rest;
}

/** Every innermost rule: selector and declaration text. */
function rulesOf(css: string): Array<{ sel: string; body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: (m[1] ?? '').trim(),
    body: (m[2] ?? '').trim(),
  }));
}

const decl = (body: string, prop: string): string[] =>
  [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) =>
    (m[1] ?? '').trim(),
  );

const ownCss = () => [
  ['skin-harbour.css', stripComments(readHarbourCss())] as const,
  ['motion.css', stripComments(readMotionCss())] as const,
];

describe('the new stylesheets are wired in with one import line each', () => {
  it('layout.tsx imports globals.css, then skin-harbour.css, then motion.css, and nothing else changed there', () => {
    const src = noComments(read('app/layout.tsx'));
    const g = src.indexOf("import './globals.css';");
    const h = src.indexOf("import './skin-harbour.css';");
    const m = src.indexOf("import './motion.css';");
    expect(g).toBeGreaterThan(-1);
    expect(h).toBeGreaterThan(g);
    expect(m).toBeGreaterThan(h);
    expect(src).toContain('data-skin={skin}');
    expect(src).not.toContain('HarbourScene');
  });
  it('no url() and no data: URI in the new files (the CSP is default-src self)', () => {
    for (const [name, css] of ownCss()) {
      expect(css, name).not.toMatch(/url\s*\(/i);
      expect(css, name).not.toContain('data:');
    }
  });
});

describe('Deep Harbour tokens (option E)', () => {
  const rules = rulesOf(stripComments(readHarbourCss())).filter((r) =>
    r.sel.includes(":root[data-skin='harbour']"),
  );
  const tokens = Object.fromEntries(
    [
      ...(rules.find((r) => r.sel === ":root[data-skin='harbour']")?.body ?? '').matchAll(
        /(--[a-z0-9-]+)\s*:\s*([^;]+);/g,
      ),
    ].map((d) => [d[1], (d[2] ?? '').replace(/\s+/g, ' ').trim()]),
  );
  it('the harbour token rule carries the spec values', () => {
    expect(rules.filter((r) => r.sel === ":root[data-skin='harbour']")).toHaveLength(1);
    const want: Record<string, string> = {
      '--bg': '#0b2233',
      '--surface': '#11344a',
      '--surface-2': '#174259',
      '--text': '#f2f6f8',
      '--muted': '#a9c1cd',
      '--line': '#6b90a3',
      '--line-soft': '#23516b',
      '--accent': '#ffb347',
      '--accent-ink': '#241400',
      '--accent-soft': '#3a3a2e',
      '--good': '#7fe0b0',
      '--good-soft': '#14423a',
      '--warn': '#ffd089',
      '--warn-soft': '#3b3320',
      '--focus': '#ffb347',
    };
    for (const [k, v] of Object.entries(want)) expect(tokens[k], k).toBe(v);
  });
  it('the display face is a serif stack made of system fonts only', () => {
    expect(tokens['--display']).toMatch(/^ui-serif,/);
    expect(tokens['--display']).toContain('Georgia');
    expect(tokens['--display']).toMatch(/serif$/);
  });
  it('declares no token name that Bright Market lacks (the two skins keep the same names)', () => {
    const globals = stripComments(readGlobalsCss());
    const market = rulesOf(globals).find((r) => r.sel.includes(":root[data-skin='market']"));
    const names = new Set(
      [...(market?.body ?? '').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((d) => d[1]),
    );
    for (const k of Object.keys(tokens)) expect(names.has(k), k).toBe(true);
  });
});

describe('every animation and transition is inside a no-preference block', () => {
  for (const [name, css] of ownCss()) {
    it(`${name}: nothing outside the block animates, except the value none`, () => {
      const rest = outsideNoPreference(css);
      expect(rest, 'keyframes').not.toContain('@keyframes');
      for (const { body } of rulesOf(rest))
        for (const prop of ['animation', 'transition']) {
          const found = [
            ...body.matchAll(new RegExp(`(?:^|[;\\s])(${prop}[a-z-]*)\\s*:\\s*([^;]+)`, 'g')),
          ];
          for (const f of found) expect(f[2]?.trim(), `${f[1]} in ${name}`).toMatch(/^none\b/);
        }
    });
  }
  it('globals.css, if it animates or transitions anything, has a reduced motion rule that stops it', () => {
    const css = stripComments(readGlobalsCss());
    const animates = rulesOf(css).some(
      (r) => /(^|[;\s])(animation|transition)[a-z-]*\s*:/.test(r.body) && !/:\s*none/.test(r.body),
    );
    if (animates) {
      const reduce = blocksOf(css, '@media (prefers-reduced-motion: reduce)').join('\n');
      expect(reduce).toMatch(/animation:\s*none/);
    }
  });
  it('the shared easing is cubic-bezier(0.16, 1, 0.3, 1) and nothing bounces', () => {
    const all = ownCss()
      .map(([, c]) => c)
      .join('\n');
    expect(all).toContain('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(all).not.toMatch(/cubic-bezier\(\s*0?\.\d+\s*,\s*1\.\d/);
    expect(all).not.toMatch(/bounce|elastic|overshoot/i);
  });
  it('will-change is never left on', () => {
    for (const [name, css] of ownCss()) expect(css, name).not.toContain('will-change');
  });
});

describe('only transform and opacity move', () => {
  const keyframes = (css: string) => blocksOf(css, '@keyframes');
  it('every keyframe step declares transform, opacity or an easing, nothing else', () => {
    let seen = 0;
    for (const [name, css] of ownCss())
      for (const k of keyframes(css))
        for (const { body } of rulesOf(k)) {
          seen++;
          for (const d of body
            .split(';')
            .map((x) => x.trim())
            .filter(Boolean)) {
            const prop = d.split(':')[0]?.trim() ?? '';
            expect(
              ['transform', 'opacity', 'animation-timing-function'],
              `${prop} in ${name}`,
            ).toContain(prop);
          }
        }
    expect(seen).toBeGreaterThan(10);
  });
  it('no transition list names left, top, right, bottom, width, height, margin, padding or background-position', () => {
    for (const [name, css] of ownCss())
      for (const { body } of rulesOf(css))
        for (const t of decl(body, 'transition'))
          expect(t, name).not.toMatch(
            /\b(left|top|right|bottom|width|height|margin|padding|background|inset)\b/,
          );
  });
  it('no animation shorthand names a layout keyframe set', () => {
    // The keyframe names are all in one list so a reviewer sees what can move.
    const names = ownCss().flatMap(([, css]) =>
      [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]),
    );
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const n of names) expect(n, 'keyframe name').toMatch(/^(hs|um)-/);
  });
});

describe('nothing near money moves, and the approval page is still', () => {
  const FORBIDDEN = /price|amount|total|fee|approve|checkout|quote|pay|receipt-line|refund/i;
  it('no animated rule names a price, amount, total, fee, approve, checkout, quote or pay selector', () => {
    for (const [name, css] of ownCss())
      for (const block of blocksOf(css, NO_PREF))
        for (const { sel, body } of rulesOf(block))
          if (/animation|transition|transform|opacity|view-transition/.test(body + sel))
            expect(sel, `${name}: ${sel}`).not.toMatch(FORBIDDEN);
  });
  it('no keyframe is named after money', () => {
    for (const [, css] of ownCss())
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) expect(m[1]).not.toMatch(FORBIDDEN);
  });
  it('the approve still rule turns every animation and transition off, outside any media block', () => {
    const css = stripComments(readMotionCss());
    const rest = outsideNoPreference(css);
    const still = rulesOf(rest).filter((r) =>
      r.sel.includes("body:has([data-testid='approve-block'])"),
    );
    expect(still.length).toBeGreaterThan(0);
    const sel = still.map((r) => r.sel).join(',');
    expect(sel).toContain("body:has([data-testid='approve-block']) *");
    expect(sel).toContain("body:has([data-testid='approve-block']) *::before");
    expect(sel).toContain("body:has([data-testid='approve-block']) *::after");
    // A single article has no approve-block; approve-total is on every approval page.
    expect(sel).toContain("body:has([data-testid='approve-total']) *");
    expect(sel).toContain("body:has([data-testid='approve-total']) *::before");
    expect(sel).toContain("body:has([data-testid='approve-total']) *::after");
    const body = still.map((r) => r.body).join(';');
    expect(body).toMatch(/animation:\s*none\s*!important/);
    expect(body).toMatch(/transition:\s*none\s*!important/);
  });
  it('the approve still rule also stops the page change fade on the approval page', () => {
    const css = stripComments(readMotionCss());
    const rules = rulesOf(outsideNoPreference(css)).filter((r) =>
      r.sel.includes("html:has([data-testid='approve-block'])::view-transition"),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((r) => r.sel).join(',')).toContain(
      "html:has([data-testid='approve-total'])::view-transition",
    );
    expect(rules.map((r) => r.body).join(';')).toMatch(/animation:\s*none\s*!important/);
  });
  it('no markup is added to the approval client', () => {
    const src = read('app/approve/[id]/ApproveClient.tsx');
    for (const w of ['HarbourScene', 'Loading', 'skeleton', 'motion']) expect(src).not.toContain(w);
  });
  it('the scene and the loading skeleton are not on any money-path page', () => {
    for (const rel of [
      'app/approve/[id]/page.tsx',
      'app/checkout/page.tsx',
      'app/orders/[ref]/page.tsx',
      'app/orders/[ref]/OrderStatus.tsx',
      'app/receipts/[order]/page.tsx',
    ]) {
      let src = '';
      try {
        src = read(rel);
      } catch {
        continue;
      }
      expect(src, rel).not.toContain('HarbourScene');
    }
  });
});

describe('durations stay short', () => {
  const secs = (v: string): number[] =>
    [...v.matchAll(/(-?\d*\.?\d+)(ms|s)\b/g)].map((m) => Number(m[1]) * (m[2] === 's' ? 1000 : 1));
  // The two loops: the hero scene and the skeleton shimmer (a loop is not a transition; spec gap, flagged in the hand-back).
  const LONG_OK = (sel: string) => /harbour-scene|\.skeleton/.test(sel);
  const CHECK = (sel: string) => /banner-title|library-status/.test(sel);
  it('250 ms or less, except the hero and skeleton loops (any length) and the success check (800 ms)', () => {
    let rules = 0;
    for (const [name, css] of ownCss())
      for (const block of blocksOf(css, NO_PREF))
        for (const { sel, body } of rulesOf(block)) {
          const times = [
            ...decl(body, 'animation'),
            ...decl(body, 'animation-duration'),
            ...decl(body, 'animation-delay'),
            ...decl(body, 'transition'),
            ...decl(body, 'transition-duration'),
          ].flatMap(secs);
          if (times.length === 0 || LONG_OK(sel)) continue;
          rules++;
          const max = CHECK(sel) ? 800 : 250;
          for (const t of times) expect(t, `${name}: ${sel}`).toBeLessThanOrEqual(max);
        }
    expect(rules).toBeGreaterThan(3);
  });
  it('the result list stagger caps its total delay at 240 ms', () => {
    const css = stripComments(readMotionCss());
    const stag = blocksOf(css, NO_PREF)
      .flatMap((b) => rulesOf(b))
      .filter((r) => r.sel.includes('.pick'));
    expect(stag.length).toBeGreaterThanOrEqual(2);
    const delays = stag.flatMap((r) =>
      [...r.body.matchAll(/animation-delay:\s*([^;]+)/g)].flatMap((m) => secs(m[1] ?? '')),
    );
    expect(Math.max(...delays)).toBeLessThanOrEqual(240);
    expect(Math.max(...delays)).toBeGreaterThan(0);
    expect(stag.map((r) => r.body).join(';')).toContain('animation:');
  });
});

describe('T9 view transitions', () => {
  it('opt in for navigation inside a no-preference block, 250 ms at most, and name no shared element', () => {
    const css = stripComments(readMotionCss());
    const inside = blocksOf(css, NO_PREF).join('\n');
    expect(inside).toMatch(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/);
    expect(inside).toContain('::view-transition-old(root)');
    expect(inside).toContain('::view-transition-new(root)');
    for (const [name, c] of ownCss()) expect(c, name).not.toContain('view-transition-name');
    expect(stripComments(readGlobalsCss())).not.toContain('view-transition-name');
  });
});

describe('T4 harbour scene', () => {
  const src = read('ui/HarbourScene.tsx');
  const code = noComments(src);
  it('is one client component with an inline SVG, hidden from assistive technology', () => {
    expect(code.trimStart().startsWith("'use client'")).toBe(true);
    expect(code).toContain('<svg');
    expect(code).toContain('aria-hidden="true"');
    expect(code).toContain('className="harbour-scene"');
    for (const bad of [
      '<text',
      '<img',
      'data:',
      'style=',
      'dangerouslySetInnerHTML',
      'Math.random',
      'Date.now',
      'performance.now',
      'localStorage',
    ])
      expect(code, bad).not.toContain(bad);
  });
  it('pauses while offscreen and while the tab is hidden, and cleans up', () => {
    expect(code).toContain('IntersectionObserver');
    expect(code).toContain('visibilitychange');
    expect(code).toContain('document.hidden');
    expect(code).toContain('is-paused');
    expect(code).toContain('removeEventListener');
    expect(code).toContain('disconnect()');
  });
  it('the CSS pauses every moving part when paused, inside the no-preference block', () => {
    const inside = blocksOf(stripComments(readHarbourCss()), NO_PREF).join('\n');
    expect(inside).toMatch(/\.harbour-scene\.is-paused[^{]*\{[^}]*animation-play-state:\s*paused/);
  });
  it('shows in Deep Harbour only', () => {
    const rest = outsideNoPreference(stripComments(readHarbourCss()));
    const hide = rulesOf(rest).find((r) =>
      r.sel.includes(":root:not([data-skin='harbour']) .harbour-scene"),
    );
    expect(hide?.body).toMatch(/display:\s*none/);
  });
  it('the waves, boat, beam, lamp and stars have keyframes; a still drawing is what reduced motion sees', () => {
    const css = stripComments(readHarbourCss());
    for (const n of ['hs-wave', 'hs-bob', 'hs-sweep', 'hs-lamp', 'hs-twinkle'])
      expect(css).toContain(`@keyframes ${n}`);
    // The scene draws without any animation property outside the block, so reduced motion is the still frame.
    expect(outsideNoPreference(css)).not.toMatch(/animation:\s*[a-z]/);
  });
  it('is on the home page and the find page only', () => {
    for (const rel of ['app/page.tsx', 'app/discover/page.tsx']) {
      const page = noComments(read(rel));
      expect(page, rel).toMatch(/import \{ HarbourScene \} from '[./]+\/ui\/HarbourScene';/);
      expect(page, rel).toContain('<HarbourScene />');
    }
    for (const rel of ['app/library/page.tsx', 'app/signin/page.tsx', 'app/help/[case]/page.tsx'])
      expect(noComments(read(rel)), rel).not.toContain('HarbourScene');
  });
});

describe('T10 skeleton shimmer', () => {
  it('Loading renders a skeleton only for the pending state, hidden from screen readers', () => {
    const src = noComments(read('ui/Loading.tsx'));
    expect(src).toContain('role="status"');
    expect(src).toContain('className="skeleton"');
    expect(src).toContain('aria-hidden="true"');
    expect(src).not.toContain('style=');
  });
  it('the shimmer moves a pseudo element with transform inside the block; the still bar is plain colour', () => {
    const css = stripComments(readMotionCss());
    const still = rulesOf(outsideNoPreference(css)).find(
      (r) => r.sel.includes('.skeleton') && !r.sel.includes('::after'),
    );
    expect(still?.body).toMatch(/background(-color)?:\s*var\(--surface-2\)/);
    const inside = blocksOf(css, NO_PREF).join('\n');
    expect(inside).toMatch(/\.skeleton[^{]*::after[^{]*\{[^}]*animation:\s*um-shimmer/);
    expect(inside).toMatch(/@keyframes um-shimmer\s*\{[^@]*transform:\s*translateX/);
  });
});

describe('T3 staggered reveal', () => {
  it('animates only the result cards wrapper with opacity and transform', () => {
    const css = stripComments(readMotionCss());
    const inside = blocksOf(css, NO_PREF).join('\n');
    expect(inside).toMatch(/section\[aria-labelledby='results'\] \.pick/);
    expect(inside).toMatch(/@keyframes um-rise\s*\{[^@]*opacity:\s*0[^@]*transform:\s*translateY/);
  });
});

describe('T12 success check', () => {
  const css = stripComments(readMotionCss());
  it('is drawn in CSS on the existing success banner and the ready library rows, with the text beside it', () => {
    const rules = rulesOf(css);
    expect(rules.some((r) => r.sel.includes('.banner-success .banner-title::before'))).toBe(true);
    expect(
      rules.some(
        (r) =>
          r.sel.includes("[data-testid='library-item']") &&
          r.sel.includes('library-status') &&
          r.sel.includes('::before'),
      ),
    ).toBe(true);
  });
  it('the still check shows for everyone; only the drawing in is animated, inside the block', () => {
    const rest = outsideNoPreference(css);
    expect(
      rulesOf(rest).some(
        (r) =>
          r.sel.includes('.banner-success .banner-title::before') && /content:\s*''/.test(r.body),
      ),
    ).toBe(true);
    const inside = blocksOf(css, NO_PREF).join('\n');
    expect(inside).toMatch(
      /\.banner-success \.banner-title::before[^{]*\{[^}]*animation:\s*um-check/,
    );
  });
  it('adds no markup: no new element or attribute in the status pages', () => {
    for (const rel of ['ui/StatusBanner.tsx', 'ui/WindowMeter.tsx', 'app/library/page.tsx'])
      expect(read(rel), rel).not.toMatch(/um-check|data-motion|skeleton/);
  });
});

describe('the lit library shelf (Deep Harbour only)', () => {
  it('draws a warm line under each library card in harbour, without moving it', () => {
    const css = stripComments(readHarbourCss());
    const rule = rulesOf(css).find(
      (r) =>
        r.sel.includes(":root[data-skin='harbour']") &&
        r.sel.includes("[data-testid='library-item']::after"),
    );
    expect(rule?.body).toMatch(/background:\s*var\(--accent\)/);
    expect(rule?.body).toMatch(/box-shadow:/);
    expect(rule?.body).not.toMatch(/animation|transition/);
  });
});
