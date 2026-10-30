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
