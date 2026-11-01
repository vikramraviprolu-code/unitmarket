// WEB-THEME state tests (docs/specs/web-theme-sections.md). The unit runner does not compile .tsx, so pages are
// read as text. Every page renders inside layout.tsx, which carries the data-skin attribute, the sticky header
// with the Appearance switch and the footer control, so one check of the layout covers every route in both
// skins; the rest pins SectionNav on the long pages with ids that match their sections.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SKINS } from './lib/skin';
import { SKIN_LABELS } from './lib/appearance-copy';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const noComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function tsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsx(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('the header carries the Appearance switch on every page', () => {
  const layout = noComments(read('app/layout.tsx'));
  const header = layout.slice(layout.indexOf('<header'), layout.indexOf('</header>'));
  it('layout.tsx puts <AppearanceSwitch> inside the site header and keeps the footer control', () => {
    expect(header).toContain('className="site-header"');
    expect(header).toContain('<AppearanceSwitch');
    expect(layout).toContain('<AppearanceControl');
    expect(layout.indexOf('<AppearanceControl')).toBeGreaterThan(layout.indexOf('</header>'));
  });
  it('the switch is a labelled group of two buttons, one per skin, with the pressed state and no storage', () => {
    const src = noComments(read('ui/AppearanceSwitch.tsx'));
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).toContain('role="group"');
    expect(src).toContain('aria-label={APPEARANCE_LEGEND}');
    expect(src).toContain('aria-pressed=');
    expect(src).toContain('SKINS.map');
    expect(src).toContain('SKIN_LABELS[s]');
    expect(src).toContain('data-testid="appearance-header"');
    expect(src).toContain("postJson('/api/appearance'");
    expect(src).toContain("documentElement.setAttribute('data-skin'");
    expect(src).toContain('role="status"');
    expect(src).not.toMatch(/localStorage|sessionStorage|location\.reload/);
    expect(Object.keys(SKIN_LABELS).sort()).toEqual([...SKINS].sort());
  });
  it('the footer control follows the skin that the header switch sets', () => {
    expect(noComments(read('ui/AppearanceControl.tsx'))).toContain('MutationObserver');
  });
  it('only the layout and the two controls touch data-skin', () => {
    const owners = new Set([
      'app/layout.tsx',
      'ui/AppearanceControl.tsx',
      'ui/AppearanceSwitch.tsx',
    ]);
    const bad = [...tsx(join(here, 'app')), ...tsx(join(here, 'ui'))]
      .map((f) => f.slice(here.length))
      .filter((f) => !owners.has(f))
      .filter((f) => /data-skin/.test(noComments(read(f))));
    expect(bad).toEqual([]);
  });
  it('no markup carries a literal colour', () => {
    const bad = [...tsx(join(here, 'app')), ...tsx(join(here, 'ui'))]
      .map((f) => f.slice(here.length))
      .filter((f) => /#[0-9a-f]{6}\b|\brgba?\(|\bhsla?\(/i.test(noComments(read(f))));
    expect(bad).toEqual([]);
  });
});

interface Spec {
  file: string;
  ids?: string[];
  dynamic?: string;
}
const PAGES: Spec[] = [
  { file: 'app/publisher/page.tsx', ids: ['figures', 'account', 'next', 'since'] },
  { file: 'app/publisher/offers/page.tsx', dynamic: 'offer-' },
  { file: 'app/publisher/sales/page.tsx', ids: ['totals', 'sales-list', 'refunds'] },
  { file: 'app/publisher/statement/page.tsx', ids: ['commission'], dynamic: 'statement-' },
  {
    file: 'app/publisher/payout-account/page.tsx',
    ids: ['payee-current', 'payee-settlement-section', 'payee-request', 'payee-history-section'],
  },
  {
    file: 'app/publisher/offers/[id]/page.tsx',
    ids: ['offer-buyer', 'offer-what', 'offer-licence-section', 'offer-history-section'],
  },
  { file: 'app/library/page.tsx', dynamic: 'library-' },
];

describe('SectionNav on the long pages, ids matching their sections', () => {
  it.each(PAGES.map((p) => [p.file, p] as const))('%s', (_f, p) => {
    const src = noComments(read(p.file));
    expect(src).toMatch(/import \{ SectionNav[^}]*\} from '(\.\.\/)+ui\/SectionNav'/);
    expect(src).toContain('<SectionNav');
    // The sections may live in a sibling component of the same route folder.
    const dir = dirname(join(here, p.file));
    const family = readdirSync(dir)
      .filter((n) => n.endsWith('.tsx'))
      .map((n) => noComments(readFileSync(join(dir, n), 'utf8')))
      .join('\n');
    for (const id of p.ids ?? []) {
      expect(src, `tab item ${id}`).toContain(`id: '${id}'`);
      expect(family, `section id ${id}`).toMatch(new RegExp(`\\bid="${id}"`));
    }
    if (p.dynamic !== undefined) {
      expect(src).toContain('id: `' + p.dynamic);
      expect(src).toContain('id={`' + p.dynamic);
    }
  });

  it('the page keeps its sections as children of <main>: SectionNav is rendered by the page, not the layout', () => {
    expect(noComments(read('app/layout.tsx'))).not.toContain('SectionNav');
  });

  it('every legal page gets a tab per heading: LegalPage renders SectionNav with the ids of its sections', () => {
    const src = noComments(read('ui/LegalPage.tsx'));
    expect(src).toContain("import { SectionNav } from './SectionNav'");
    expect(src).toContain('legalSectionIds(');
    expect(src).toContain('<SectionNav');
    expect(src).toContain('id={ids[');
    for (const slug of ['terms', 'privacy', 'refunds', 'publisher-terms'])
      expect(noComments(read(`app/legal/${slug}/page.tsx`))).toContain('<LegalPage');
  });
});
