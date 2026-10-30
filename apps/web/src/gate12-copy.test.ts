// FIX-DOCS (docs/specs/fix-docs-gate12.md): pins the gate 12 copy fixes that no golden covers. The unit
// runner does not compile .tsx, so page sources are read as text. README is read as text too.
import { readFileSync } from 'node:fs';
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

  it('does not claim lanes that are not merged', () => {
    expect(readme).not.toMatch(/reader view|sales page|statement page/i);
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
