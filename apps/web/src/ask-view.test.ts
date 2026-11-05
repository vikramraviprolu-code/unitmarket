// INT-GA / GA.2: the ask box logic (pure). The chips the server proposes are shown with the filter bar's own
// words, the dropped fields are named, and nothing runs until the person applies: applying merges the chips into the
// page's URL map through the bar's own parser, so a refused or invalid field never reaches a link. An operator
// without the second factor gets the sign-in line instead of the box. FilterBar hosts the box.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_MFA_TEXT, ASK_TEXT_MAX, askAllowed, askHref, askView } from './lib/ask-view';

const here = fileURLToPath(new URL('.', import.meta.url));
const buyerCtx = { kind: 'txn', persona: 'buyer' } as const;

describe('askView', () => {
  it('labels each chip with the filter bar words, and names the dropped fields', () => {
    const v = askView(buyerCtx, { status: 'attention', from: '2026-11-01' }, ['buyer', 'number']);
    expect(v.chips.map((c) => c.field).sort()).toEqual(['from', 'status']);
    expect(v.chips.find((c) => c.field === 'status')!.text).toMatch(/Needs attention/);
    expect(v.dropped).toMatch(/buyer/i);
    expect(v.dropped).toMatch(/number/i);
    expect(v.empty).toBe(false);
  });
  it('no chips and nothing dropped is an empty answer with a plain line', () => {
    const v = askView(buyerCtx, {}, []);
    expect(v.empty).toBe(true);
    expect(v.dropped).toBe('');
    expect(v.note.length).toBeGreaterThan(0);
  });
  it('a refused field in the proposal is never shown as a chip', () => {
    const v = askView({ kind: 'txn', persona: 'publisher' }, { buyer: 'x', status: 'paid' }, []);
    expect(v.chips.map((c) => c.field)).toEqual(['status']);
  });
});

describe('askHref', () => {
  it('merges the proposed chips into the current URL map; the proposal wins on the same field', () => {
    expect(
      askHref(
        buyerCtx,
        '/buyer/spending',
        { status: 'paid', currency: 'USD' },
        { status: 'attention' },
      ),
    ).toBe('/buyer/spending?currency=USD&status=attention');
  });
  it('drops refused, invalid and cursor fields', () => {
    const href = askHref(
      buyerCtx,
      '/b',
      { cursor: 'abc' },
      { buyer: 'x', status: 'bogus', from: '2026-11-01' },
    );
    expect(href).toBe('/b?from=2026-11-01');
  });
});

describe('who may ask', () => {
  it('everyone but an operator without the second factor', () => {
    expect(askAllowed('buyer')).toBe(true);
    expect(askAllowed('publisher')).toBe(true);
    expect(askAllowed('operator')).toBe(true);
    expect(askAllowed('operator_key')).toBe(false);
    expect(ASK_MFA_TEXT).toBe('Sign in with your authenticator to use Ask');
    expect(ASK_TEXT_MAX).toBe(500);
  });
});

describe('the box, read as text', () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const box = strip(readFileSync(join(here, 'ui/AskBox.tsx'), 'utf8'));
  const bar = strip(readFileSync(join(here, 'ui/FilterBar.tsx'), 'utf8'));
  it('FilterBar hosts AskBox for the transaction bar only', () => {
    expect(bar).toMatch(/<AskBox/);
    expect(bar).toMatch(/ctx\.kind === 'txn'/);
  });
  it('the box posts to the one route, shows the chips and applies only on a click', () => {
    expect(box).toMatch(/postJson[^(]*\('\/api\/assist\/query'/);
    expect(box).toMatch(/askHref\(/);
    expect(box).toMatch(/router\.push/);
    expect(box).not.toMatch(/dangerouslySetInnerHTML/);
    expect(box).toMatch(/<label/);
  });
});
