// INT-UI0 / UI0.1: the shell files, read as text (the flow-a11y.state.test.ts method: the unit runner
// does not compile .tsx). No axe-core (D-008, D-066). Landmarks are labelled, the active tab says
// aria-current="page", the phone bar has its rule under max-width 640px, the search slot takes focus on
// "/" without a request, and no environment word is typed in a shell file (P16, rule 7).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const FILES = [
  'ui/shell/Shell.tsx',
  'ui/shell/Tabs.tsx',
  'ui/shell/Breadcrumb.tsx',
  'ui/shell/SearchSlot.tsx',
  'ui/shell/PhoneBar.tsx',
];

describe('every shell file exists and types no environment word', () => {
  it.each(FILES)('%s', (f) => {
    const src = code(f);
    expect(src.length).toBeGreaterThan(100);
    expect(src).not.toMatch(/Sandbox|Dry run/);
  });
  it('the css has none either', () => {
    expect(code('ui/shell/shell.css')).not.toMatch(/Sandbox|Dry run/);
  });
});

describe('Tabs', () => {
  const src = code('ui/shell/Tabs.tsx');
  it('is a labelled nav with a list', () => {
    expect(src).toMatch(/<nav[^>]*aria-label=/);
    expect(src).toContain('<ul');
  });
  it('marks the active tab with aria-current="page"', () => {
    expect(src).toMatch(/aria-current=\{[^}]*'page'/);
    expect(src).toContain('activeTabId(');
  });
  it('lists only ready tabs, from the shell-tabs data', () => {
    expect(src).toContain('visibleTabs(');
    expect(src).not.toMatch(/coming soon/i);
  });
  it('shows the section tabs of Sellers and Controls in their own labelled nav', () => {
    expect(src).toContain('subTabsFor(');
    expect(src).toMatch(/aria-label=\{`[^`]*sections`\}|aria-label="[^"]*sections"/);
  });
});

describe('Breadcrumb', () => {
  const src = code('ui/shell/Breadcrumb.tsx');
  it('is a nav labelled Breadcrumb holding an ordered list', () => {
    expect(src).toMatch(/<nav[^>]*aria-label="Breadcrumb"/);
    expect(src).toContain('<ol');
    expect(src).toContain('breadcrumbFor(');
  });
  it('marks the last crumb as the current page', () => {
    expect(src).toMatch(/aria-current=\{[^}]*'page'/);
  });
});

describe('SearchSlot', () => {
  const src = code('ui/shell/SearchSlot.tsx');
  it('is a labelled search field', () => {
    expect(src).toMatch(/role="search"/);
    expect(src).toMatch(/type="search"/);
    expect(src).toMatch(/<label|aria-label=/);
  });
  it('takes focus when / is pressed outside a field, and never sends a request', () => {
    expect(src).toMatch(/key === '\/'/);
    expect(src).toMatch(/\.focus\(\)/);
    expect(src).toContain('preventDefault');
    expect(src).toMatch(/INPUT|TEXTAREA|SELECT|isContentEditable/);
    expect(src).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|router\.(push|replace)|location\./);
  });
  it('a submit does nothing yet (search arrives with OPS-B)', () => {
    expect(src).toMatch(/onSubmit=\{[^}]*preventDefault/);
  });
});

describe('PhoneBar', () => {
  const src = code('ui/shell/PhoneBar.tsx');
  it('is a labelled nav of the same ready tabs', () => {
    expect(src).toMatch(/<nav[^>]*aria-label=/);
    expect(src).toContain('visibleTabs(');
    expect(src).toContain('aria-current');
  });
  it('is shown only on a phone: the rule sits under @media (max-width: 640px)', () => {
    const css = code('ui/shell/shell.css');
    expect(css).toMatch(
      /@media \(max-width: 640px\)\s*\{[\s\S]*\.shell-phonebar\s*\{[^}]*display:\s*(flex|grid)/,
    );
    // Off a phone the bar is hidden by default.
    expect(css).toMatch(/\.shell-phonebar\s*\{[^}]*display:\s*none/);
  });
  it('keeps every target 44px tall and clear of the page end', () => {
    const css = code('ui/shell/shell.css');
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/safe-area-inset-bottom/);
  });
});

describe('Shell', () => {
  const src = code('ui/shell/Shell.tsx');
  it('shows the environment pill from stored data through EnvLabel', () => {
    expect(src).toContain('<EnvLabel environment={');
    expect(src).toContain("from '../EnvLabel'");
  });
  it('composes the tabs, the breadcrumb, the search slot and the phone bar', () => {
    for (const c of ['<Tabs', '<Breadcrumb', '<SearchSlot', '<PhoneBar']) expect(src).toContain(c);
  });
  it('takes a persona and an environment, and no identity', () => {
    expect(src).not.toMatch(/email|buyer_id|display_name|actor\./);
  });
});

describe('the root layout and the nav', () => {
  it('renders the Shell from the actor kind', () => {
    const src = code('app/layout.tsx');
    expect(src).toContain('<Shell');
    expect(src).toContain('personaForActor(');
  });
  it('EnvLabel and SectionNav are extended, not copied (no second copy under ui/shell)', () => {
    const files = FILES.map((f) => code(f)).join('\n');
    expect(files).not.toMatch(/function EnvLabel|function SectionNav/);
  });
  it('the seller nav label is Seller, the URL stays /publisher', () => {
    const copy = readFileSync(join(here, 'lib/publisher-copy.ts'), 'utf8');
    expect(copy).toContain("export const PUBLISHER_NAV_LABEL = 'Seller';");
    expect(code('lib/nav.ts')).toContain("href: '/publisher'");
  });
});

describe('Ref (UI0.4) and Timeline (UI0.6), read as text', () => {
  it('Ref copies the whole reference through copyText and announces the result politely', () => {
    const src = code('ui/Ref.tsx');
    expect(src).toContain("'use client'");
    expect(src).toContain('copyText(value)');
    expect(src).toContain('navigator.clipboard.writeText(text)');
    expect(src).toMatch(/role="status"/);
    expect(src).toMatch(/<button type="button"/);
    // The short form is for the eye; a screen reader gets the whole reference.
    expect(src).toMatch(/aria-hidden="true"/);
    expect(src).toContain('visually-hidden');
  });
  it('Timeline paints the view and decides nothing: an ordered list, no script', () => {
    const src = code('ui/Timeline.tsx');
    expect(src).toContain('<ol');
    expect(src).toContain('aria-label={label}');
    expect(src).toMatch(/role="alert"/);
    expect(src).not.toMatch(/useState|useEffect|'use client'|fetch\(|\.sort\(/);
  });
});
