// SKIN-A golden: the token table of each skin, read from globals.css (golden/skin-tokens.golden.txt).
// The reviewed file is the contract for how the app looks; SKIN-B updates the harbour block.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SKINS, readGlobalsCss, skinTokens } from './skin-css-test-support';

const NAMES: Record<(typeof SKINS)[number], string> = {
  market: 'Bright Market',
  harbour: 'Deep Harbour',
};

describe('skin token table (golden)', () => {
  it('matches golden/skin-tokens.golden.txt', () => {
    const css = readGlobalsCss();
    const lines: string[] = [
      '# Token table per skin (SKIN-A). Read from globals.css by skin-tokens.golden.test.ts.',
      '# A change here is a change to how the whole app looks and to the contrast it must keep.',
    ];
    for (const skin of SKINS) {
      lines.push('', `[${skin}] ${NAMES[skin]}`);
      for (const [k, v] of skinTokens(css, skin)) lines.push(`${k}: ${v}`);
    }
    const golden = readFileSync(
      new URL('./golden/skin-tokens.golden.txt', import.meta.url),
      'utf8',
    );
    expect(lines.join('\n') + '\n').toBe(golden);
  });
});
