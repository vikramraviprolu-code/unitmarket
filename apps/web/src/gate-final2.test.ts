// GATE-FINAL-FIX2: polish items from the final real-browser gate. Pages are .tsx files the unit runner does
// not compile, so their source is read as text. Nothing here touches the money path.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANCEL_BODY, CANCEL_BODY_NO_REF } from './lib/composite-copy';
import { licenceText } from './lib/offer-copy';
import { CREATE_TERMS_NOTE } from './lib/publisher-e1-copy';
import { PUBLISHER_TERMS_DOC } from './lib/legal-copy';
import { COMMISSION_LINE } from '@umsbx/publisher-console';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('defect 2: the hover pill belongs to the site header only', () => {
  it('no unscoped `nav a:hover` rule is left in globals.css', () => {
    const css = read('./app/globals.css');
    expect(css).not.toMatch(/(^|\n)nav a:hover/);
    expect(css).toMatch(/\.site-header nav a:hover\s*\{/);
  });
  it('the harbour skin has no unscoped nav hover rule', () => {
    expect(read('./app/skin-harbour.css')).not.toMatch(/(^|[\s,}])nav a:hover/);
  });
});

describe('defect 4: publisher sales totals table', () => {
  const page = read('./app/publisher/sales/page.tsx');
  it('shows the sideways hint above both tables', () => {
    expect(page.match(/Scroll sideways to see more/g)?.length).toBe(2);
  });
  it('the currency cell shows the plain code beside the label, not the block heading', () => {
    expect(page).not.toContain('blockHeading');
    expect(page).toMatch(/\{t\.currency\}\{' '\}\s*<EnvLabel environment=\{t\.environment\} \/>/);
  });
});

describe('defect 5: the AI-use terms agree on both sides', () => {
  it('the publisher licence for `review` says what the buyer is told', () => {
    const t = licenceText({ scope: 'personal_use', ai_scope: 'review', redistribution: false });
    expect(t).toBe('Personal use only. No redistribution. Buyers may not use it with AI tools under this offer.');
    expect(t).not.toMatch(/AI assistants may read/);
  });
  it('the create-offer terms note agrees', () => {
    expect(CREATE_TERMS_NOTE('terms-1')).toBe(
      'Terms version terms-1. The access window is set by UnitMarket. Personal use only. No redistribution. Buyers may not use it with AI tools under this offer.',
    );
  });
});

describe('defect 6: copy items', () => {
  it('the cancel page does not name PayPal', () => {
    expect(CANCEL_BODY_NO_REF).toBe(
      'You did not approve this payment at the payment step. Nothing was charged for this payment.',
    );
    expect(CANCEL_BODY).toContain('at the payment step.');
  });
  it('the commission line makes no promise of a plan', () => {
    expect(COMMISSION_LINE).toBe('No commission in this demo.');
    const flat = JSON.stringify(PUBLISHER_TERMS_DOC);
    expect(flat).not.toMatch(/20 percent|not implemented/i);
    expect(flat).toContain('No commission in this demo.');
  });
  it('the frozen help topic does not claim a case was opened before any order is named', () => {
    const src = read('./app/help/[case]/page.tsx');
    expect(src).not.toContain('We opened a case');
    expect(src).toContain('If this happens, we open a case and will write to you with the outcome.');
  });
});
