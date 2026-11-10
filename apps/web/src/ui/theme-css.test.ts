// WEB-THEME (docs/specs/web-theme-sections.md): every stylesheet follows the two skins through tokens only.
// Pins: no literal colour outside the two token blocks, no url() or data: URI (CSP default-src 'self'), the
// header is sticky with a fixed height token that the section tabs sit under, and the kit components carry the
// skin's display font, radius and shadow. The unit runner reads the stylesheets as text.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../skin-css-test-support';

const srcDir = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}
const FILES = [...cssFiles(join(srcDir, 'app')), ...cssFiles(join(srcDir, 'ui'))];
const rel = (p: string) => p.slice(srcDir.length);

/** Every rule as [selector, body], @media wrappers flattened (the sheets keep one declaration per line). */
function rules(css: string): Array<[string, string]> {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
    (m[1] ?? '').trim().replace(/\s+/g, ' '),
    m[2] ?? '',
  ]);
}
const TOKEN_BLOCK =
  /^:root(\[data-skin='(market|harbour)'\])?$|^:root, :root\[data-skin='market'\]$/;
const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bhwb\(/i;

/** The bodies of the rules whose selector list holds exactly `sel`. */
function body(css: string, sel: string): string {
  const hits = rules(css)
    .filter(([s]) =>
      s
        .split(',')
        .map((x) => x.trim())
        .includes(sel),
    )
    .map(([, b]) => b);
  if (hits.length === 0) throw new Error(`no rule for ${sel}`);
  return hits.join('\n');
}
const all = (): string => FILES.map((f) => readFileSync(f, 'utf8')).join('\n');

describe('no literal colour outside the token blocks', () => {
  it('scans every stylesheet under app and ui', () => {
    expect(FILES.map(rel)).toEqual(
      expect.arrayContaining(['app/globals.css', 'app/skin-harbour.css', 'app/motion.css']),
    );
  });
  // Allow list: empty. The cover patterns, the hero rings and the harbour scene take their tint from the
  // overlay and scene tokens (color-mix on a token), so no rule needs a literal.
  const ALLOW: string[] = [];
  it.each(FILES.map((f) => [rel(f), f] as const))('%s', (_name, f) => {
    const bad = rules(readFileSync(f, 'utf8'))
      .filter(([sel]) => !TOKEN_BLOCK.test(sel))
      .filter(([, b]) => LITERAL.test(b))
      .map(([sel]) => sel)
      .filter((sel) => !ALLOW.includes(sel));
    expect(bad).toEqual([]);
  });
  it('no url() and no data: URI in any stylesheet (CSP default-src self)', () => {
    expect(stripComments(all())).not.toMatch(/url\(/);
    expect(stripComments(all())).not.toContain('data:');
  });
});

describe('the header is sticky and the section tabs sit directly under it', () => {
  const g = readFileSync(join(srcDir, 'app/globals.css'), 'utf8');
  const nav = readFileSync(join(srcDir, 'ui/section-nav.css'), 'utf8');
  it('declares --header-h (one row, two rows, phone) and a sticky .site-header at least that tall', () => {
    expect(rules(g).filter(([s, b]) => s === ':root' && b.includes('--header-h')).length).toBe(3);
    const h = body(g, '.site-header');
    expect(h).toMatch(/position:\s*sticky/);
    expect(h).toMatch(/top:\s*0/);
    expect(h).toMatch(/z-index:\s*\d+/);
    expect(body(g, '.site-header .inner')).toMatch(/(^|[\s;])min-height:\s*var\(--header-h\)/);
    expect(body(g, '.site-header .inner')).not.toMatch(/(^|[\s;])height:\s*var\(--header-h\)/);
  });
  // WEB-POLISH-1: the one-row content needs about 1030px and .inner is capped, so one row only from 1200px; two
  // rows from 560 to 1199px; under 560px the header scrolls away (--header-h is 0) and links wrap, never hide.
  it('lays the header out in three width bands (1200 and up, 560 to 1199, under 560)', () => {
    const c = stripComments(g);
    expect(c).toMatch(/@media \(max-width: 1199px\)/);
    expect(c).toMatch(/@media \(max-width: 559px\)/);
    expect(c).toMatch(/@media \(min-width: 1200px\)/);
    expect(c).not.toMatch(/@media \(max-width: 600px\)\s*\{\s*:root/);
    expect(c).toMatch(/--header-h:\s*0px/);
    const phone = c.slice(c.indexOf('@media (max-width: 559px)'));
    expect(phone).toMatch(/position:\s*relative/);
    expect(body(g, '.site-header nav ul')).toMatch(/white-space:\s*nowrap|flex-wrap/);
  });
  it('never hides or scrolls a header link sideways', () => {
    expect(stripComments(g)).not.toMatch(/\.site-header nav\s*\{[^}]*overflow-x:\s*auto/);
  });
  // WEB-POLISH-4 replaces the old pin ("sticks at --header-h and scroll-padding-top clears both bars"): the tab
  // bar now wraps onto as many rows as it needs, never scrolls sideways, and is not sticky (no width exists at
  // which every page's tab set fits one row), so only the sticky site header has to be cleared.
  it('.section-nav wraps, never scrolls sideways and is not sticky', () => {
    const c = stripComments(nav);
    expect(body(nav, '.section-nav ul')).toMatch(/flex-wrap:\s*wrap/);
    expect(body(nav, '.section-nav ul')).not.toMatch(/nowrap/);
    expect(body(nav, '.section-nav')).not.toMatch(/overflow-x|overflow:\s*(auto|scroll)/);
    expect(c).not.toMatch(/position:\s*sticky/);
    expect(c).not.toMatch(/top:\s*var\(--header-h\)/);
  });
  it('scroll-padding-top clears the sticky site header from --header-h, with no fixed bar height', () => {
    expect(body(nav, 'html')).toMatch(
      /scroll-padding-top:\s*calc\(var\(--header-h\)\s*\+\s*var\(--space\)\)/,
    );
  });
});

describe('the header switch', () => {
  const g = readFileSync(join(srcDir, 'app/globals.css'), 'utf8');
  it('has 44px targets and a pressed state taken from tokens', () => {
    expect(body(g, '.skin-switch button')).toMatch(/min-height:\s*44px/);
    expect(body(g, '.skin-switch button')).toMatch(/min-width:\s*44px/);
    expect(body(g, ".skin-switch button[aria-pressed='true']")).toMatch(/background:\s*var\(--/);
  });
});

describe('OPS-WRAP-1: a long fact label wraps inside its own column', () => {
  const p = readFileSync(join(srcDir, 'app/publisher/publisher.css'), 'utf8');
  // "Capture of unt_<26 chars>" on the operator order page has no break point; without these the label spills
  // over the value beside it.
  it('.pk-facts dt can shrink to its column and breaks a long id anywhere, as dd does', () => {
    for (const sel of ['.pk-facts dt', '.pk-facts dd']) {
      const b = body(p, sel);
      expect(b).toMatch(/min-width:\s*0/);
      expect(b).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });
});

describe('the kit components carry the skin: display font, radius, shadow', () => {
  const p = readFileSync(join(srcDir, 'app/publisher/publisher.css'), 'utf8');
  it.each([
    ['.pk-chip'],
    ['.pk-tile-label'],
    ['.pk-tile-value'],
    ['.pk-card-title'],
    ['.pk-head h1'],
    ['.pk-section > h2'],
  ])('%s uses var(--display)', (sel) => {
    expect(body(p, sel)).toMatch(/font-family:\s*var\(--display\)/);
  });
  it.each([['.pk-tile'], ['.pk-card'], ['.pk-panel'], ['.pk-head']])(
    '%s uses the skin radius and shadow',
    (sel) => {
      const b = body(p, sel);
      expect(b).toMatch(/border-radius:\s*var\(--radius/);
      expect(b).toMatch(/box-shadow:\s*var\(--shadow\)/);
    },
  );
  it('.pk-chip takes the skin button radius', () => {
    expect(body(p, '.pk-chip')).toMatch(/border-radius:\s*var\(--radius-btn\)/);
  });
  it('the page header is a skin band: background from --band, ink from --header-ink', () => {
    const b = body(p, '.pk-head');
    expect(b).toMatch(/background:\s*var\(--band\)/);
    expect(b).toMatch(/color:\s*var\(--header-ink\)/);
  });
});
