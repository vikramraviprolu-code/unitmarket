// FIX-DOCS (docs/specs/fix-docs-gate12.md): pins the gate 12 copy fixes that no golden covers. The unit
// runner does not compile .tsx, so page sources are read as text. README is read as text too.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moneyStateText } from './lib/buyer-copy';
import { LINE_TEXT } from './lib/composite-copy';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const readme = read('../../../README.md');

describe('README (D2, D3)', () => {
  it('names the publisher passcode hash, by name only, and how to make one', () => {
    expect(readme).toContain('UMS_PUBLISHER_PASSCODE_HASH');
    expect(readme).toContain('owner:secrets');
    expect(readme).toMatch(/Publisher passcode/);
    expect(readme).not.toMatch(/UMS_PUBLISHER_PASSCODE_HASH=[A-Za-z0-9:]/);
  });

  it('lists the merged lanes and no longer calls them in progress', () => {
    expect(readme).not.toMatch(/In progress/);
    expect(readme).toContain('UMS_AI_ADAPTER');
    expect(readme).toContain('UMS_ANTHROPIC_API_KEY');
    expect(readme).toMatch(/Appearance/);
    expect(readme).toMatch(/payee change/i);
    expect(readme).toMatch(/legal pages/i);
  });

  // The reader view (READER-A), the sales page and the statement page (PUB-C) merged to main after this test was
  // written, so the README now names them. Each claim is tied to its page source on main, so the README cannot
  // name a lane whose page is missing. Lanes that are not on main stay unclaimed (negative checks below).
  it('claims the reader view, sales page and statement page only while their pages exist on main', () => {
    const pages: Array<[RegExp, string]> = [
      [/reader view/i, './app/library/[entitlement]/read/page.tsx'],
      [/sales page/i, './app/publisher/sales/page.tsx'],
      [/statement page/i, './app/publisher/statement/page.tsx'],
    ];
    for (const [claim, page] of pages) {
      if (claim.test(readme)) {
        expect(
          existsSync(fileURLToPath(new URL(page, import.meta.url))),
          `README names ${claim} but ${page} is missing`,
        ).toBe(true);
      }
    }
  });

  it('claims a lane as merged only while its route exists, and does not claim lanes that are not merged', () => {
    // Buyer cancel of an unpaid order (ORDER-A) is merged: its row is in the "What works today" table, which says
    // every row in it is merged on main, and its route exists on main.
    const cancelRow = readme
      .split('\n')
      .find((line) => /Buyer cancel of an unpaid order/.test(line));
    expect(cancelRow, 'the cancel row is listed').toBeDefined();
    const works = readme.split(/^## /m).find((s) => s.startsWith('What works today'));
    expect(works, 'the What works today section exists').toBeDefined();
    expect(works).toMatch(/Everything in this table is merged on `main`/);
    expect(works).toContain(cancelRow);
    expect(
      existsSync(fileURLToPath(new URL('./app/api/orders/[ref]/cancel/route.ts', import.meta.url))),
      'README says the cancel lane is merged but its route is missing',
    ).toBe(true);
    // WordPress lanes are not merged: the README must not name them.
    expect(readme).not.toMatch(/wordpress/i);
    // Paying Quayside Gazette into its own account is not built: any sentence about it must say so.
    const direct = readme.split('\n').filter((line) => /Quayside Gazette directly/i.test(line));
    for (const line of direct) expect(line).toMatch(/not built/i);
  });
});

describe('D12: plain words on the item page', () => {
  it('moneyStateText gives words for every stored money state and none for the raw value', () => {
    expect(moneyStateText('pending')).toBe(LINE_TEXT.pending);
    expect(moneyStateText('captured')).toBe('Paid');
    expect(moneyStateText('denied')).toBe(LINE_TEXT.declined);
    expect(moneyStateText('refunded')).toBe('Refunded');
    expect(moneyStateText('reversed')).toBe('Payment reversed');
    expect(moneyStateText('unknown')).toBe(LINE_TEXT.confirming);
    expect(moneyStateText('something_new')).toBe(LINE_TEXT.confirming);
  });

  it('the item page shows the words, not the raw state, under the label Payment', () => {
    const page = read('./app/library/[entitlement]/page.tsx');
    expect(page).toMatch(/moneyStateText\(item\.money(, [^)]*)?\)/);
    expect(page).not.toContain('{item.money}');
    expect(page).not.toContain('Payment state');
  });
});

describe('D12: the no-tick error', () => {
  const form = read('./app/discover/DiscoverForm.tsx');
  it('says before buying and never "before choosing an article"', () => {
    expect(form).not.toContain('before choosing an article');
    expect(form).toContain('before buying');
  });
  it('shows the pack error next to the Buy button', () => {
    expect(form).toMatch(/packError/);
    expect(form).toMatch(/pack-error/);
  });
});
