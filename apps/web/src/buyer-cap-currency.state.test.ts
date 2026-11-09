// OFFER-CUR (docs/specs/catalogue-offer-currency.md): the currency pickers of the seller create form and the buyer
// New cap form, and the buyer words for two approval refusals. The pages are .tsx files the unit runner does not
// compile, so their source is read as text, as the other page tests do.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capRequest } from './lib/buyer-agents-view';
import { CORRIDOR_UNSUPPORTED_TEXT, PUBLISHER_UNVERIFIED_TEXT } from './lib/composite-copy';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (s: string): string => s.replace(/\/\/.*$/gm, '');

const base = {
  agent_key_id: 'key_f1',
  money_text: '5.00',
  count_text: '',
  until_day: '2026-11-30',
};

describe('the buyer New cap form', () => {
  it('builds the body in the chosen currency', () => {
    for (const currency of ['USD', 'EUR', 'GBP']) {
      const r = capRequest({ ...base, currency });
      expect(r.ok && r.body.currency).toBe(currency);
    }
  });
  it('the agents page no longer hard codes USD and hands the list of currencies to the form', () => {
    const page = strip(read('./app/buyer/agents/page.tsx'));
    expect(page).not.toMatch(/currency="USD"/);
    expect(page).toMatch(/currencies=\{/);
  });
  it('the form has a currency select, starts on the first currency and sends the chosen one', () => {
    const form = strip(read('./ui/buyer/CapForm.tsx'));
    expect(form).toContain('data-testid="cap-currency"');
    expect(form).toMatch(/<select[^>]*value=\{currency\}/);
    expect(form).toMatch(/currencies\[0\]/);
    expect(form).toMatch(/capRequest\(\{[^}]*currency,/s);
    expect(form).toMatch(/Money cap \(\{currency\}\)/);
  });
});

describe('the seller create form', () => {
  it('the page hands every covered currency to the form', () => {
    const page = strip(read('./app/publisher/offers/new/page.tsx'));
    expect(page).toContain('view.currencies');
    expect(page).toMatch(/currencies=\{/);
  });
  it('the form shows a currency select only when there is more than one, and sends currency only then', () => {
    const form = strip(read('./app/publisher/offers/new/CreateForm.tsx'));
    expect(form).toContain('data-testid="create-currency"');
    expect(form).toMatch(/currencies\.length > 1/);
    expect(form).toMatch(/\{ currency \}/);
    expect(form).not.toMatch(/publisher_id|style=/);
  });
});

describe('the buyer words for two approval refusals', () => {
  it('say what to do, with no dash', () => {
    expect(CORRIDOR_UNSUPPORTED_TEXT).toBe(
      'Items from publishers in India are paid separately. Buy them in a separate order.',
    );
    expect(PUBLISHER_UNVERIFIED_TEXT.length).toBeGreaterThan(20);
    expect(`${CORRIDOR_UNSUPPORTED_TEXT} ${PUBLISHER_UNVERIFIED_TEXT}`).not.toMatch(/[-‐-―−]/);
  });
  it('both approval doors use them', () => {
    for (const f of ['./app/api/approvals/route.ts', './api-v1/buyer.ts']) {
      const src = read(f);
      expect(src).toContain('corridor_unsupported: CORRIDOR_UNSUPPORTED_TEXT');
      expect(src).toContain('publisher_unverified: PUBLISHER_UNVERIFIED_TEXT');
    }
  });
});
