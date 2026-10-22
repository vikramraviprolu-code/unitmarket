// Gate review L2: the footer and the page description follow the stored environment label, so a
// dry-run build never says "Sandbox build" next to the "Dry run" badge.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteDescription, siteFooter } from './ui/env-copy';

describe('environment copy (L2)', () => {
  it('dry run says dry run and never sandbox', () => {
    for (const text of [siteFooter('dryrun'), siteDescription('dryrun')]) {
      expect(text).toMatch(/dry run/i);
      expect(text).not.toMatch(/sandbox/i);
      expect(text).toMatch(/no real money/i);
    }
  });
  it('sandbox says sandbox and never dry run', () => {
    for (const text of [siteFooter('sandbox'), siteDescription('sandbox')]) {
      expect(text).toMatch(/sandbox/i);
      expect(text).not.toMatch(/dry run/i);
      expect(text).toMatch(/no real money/i);
    }
  });
  it('the layout carries no fixed environment wording', () => {
    const src = readFileSync(new URL('./app/layout.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox build/);
    expect(src).toContain('siteFooter(');
    expect(src).toContain('siteDescription(');
  });
});
