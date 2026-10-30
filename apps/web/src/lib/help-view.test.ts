// GATEFIX2 item 2: a help page offers to open a case only from an item. Pure view, so every topic can be listed.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HELP_NO_ITEM_LINK, HELP_NO_ITEM_NOTE, helpView } from './help-view';

describe('helpView', () => {
  it('with no item there is no case button, only guidance and a link to My library', () => {
    for (const slug of ['payment', 'frozen', 'delivery', 'not-charged']) {
      const v = helpView(slug, undefined);
      expect(v.canOpenCase).toBe(false);
      expect(v.note).toBe(HELP_NO_ITEM_NOTE);
      expect(v.link).toEqual({ href: '/library', text: HELP_NO_ITEM_LINK });
    }
  });
  it('an empty item counts as no item', () => {
    expect(helpView('payment', '').canOpenCase).toBe(false);
  });
  it('with an item the case button stays and no library link is added', () => {
    const v = helpView('delivery', 'ent_123');
    expect(v.canOpenCase).toBe(true);
    expect(v.note).toBeNull();
    expect(v.link).toBeNull();
  });
  it('the words carry no dash and say where to start', () => {
    expect(`${HELP_NO_ITEM_NOTE} ${HELP_NO_ITEM_LINK}`).not.toMatch(/[‒-―−]| - |--/);
    expect(HELP_NO_ITEM_NOTE).toMatch(/item/i);
    expect(HELP_NO_ITEM_LINK).toBe('Open My library');
  });
  it('the page renders the case button only through the view', () => {
    const src = readFileSync(new URL('../app/help/[case]/page.tsx', import.meta.url), 'utf8').replace(
      /\/\/.*$/gm,
      '',
    );
    expect(src).toContain('helpView(');
    expect(src).toMatch(/view\.canOpenCase/);
  });
});
