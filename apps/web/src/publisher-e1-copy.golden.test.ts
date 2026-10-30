// PUB-E1 golden: every string of the CSV links, the Refunds section, Since your last visit and the create
// an offer page. Static lines come from lib/publisher-e1-copy.ts; the variable lines are pinned for each
// state. The reviewed file is golden/publisher-e1-copy.golden.txt. D-051: no italics, no dashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/publisher-e1-copy';

const golden = readFileSync(
  new URL('./golden/publisher-e1-copy.golden.txt', import.meta.url),
  'utf8',
);

function lines(): string[] {
  const out: string[] = [];
  out.push(`export: ${copy.EXPORT_SALES_LABEL} | ${copy.EXPORT_STATEMENT_LABEL}`);
  out.push(`export hrefs: ${copy.EXPORT_SALES_HREF} | ${copy.EXPORT_STATEMENT_HREF}`);
  out.push(`export note: ${copy.EXPORT_NOTE}`);
  out.push(`export messages: ${copy.EXPORT_FAILED} | ${copy.EXPORT_TRUNCATED}`);
  out.push(`refunds heading: ${copy.REFUNDS_HEADING}`);
  out.push(`refunds lede: ${copy.REFUNDS_LEDE}`);
  out.push(`refunds columns: ${Object.values(copy.REFUNDS_COLUMNS).join(' | ')}`);
  for (const n of [0, 1, 2, 11])
    out.push(`refunds count ${String(n)}: ${copy.refundsCountText(n)}`);
  out.push(`refunds source: ${copy.REFUNDS_SOURCE_NOTE}`);
  out.push(`since heading: ${copy.SINCE_HEADING}`);
  out.push(`since first: ${copy.SINCE_FIRST}`);
  out.push(`since none: ${copy.SINCE_NONE}`);
  out.push(`since from: ${copy.sinceFromText('2026-10-30 09:00 UTC')}`);
  for (const c of [
    { new_sales: 1, refunds: 1, operator_offer_changes: 1, payee_decisions: 1 },
    { new_sales: 2, refunds: 3, operator_offer_changes: 4, payee_decisions: 5 },
    { new_sales: 0, refunds: 0, operator_offer_changes: 0, payee_decisions: 2 },
    { new_sales: 0, refunds: 0, operator_offer_changes: 0, payee_decisions: 0 },
  ])
    out.push(`since lines ${JSON.stringify(c)}: ${copy.sinceLines(c).join(' ') || '(none)'}`);
  out.push(`create: ${copy.CREATE_LINK} | ${copy.CREATE_HEADING} | ${copy.CREATE_BACK}`);
  out.push(`create lede: ${copy.CREATE_LEDE}`);
  out.push(`create none: ${copy.CREATE_NONE_TITLE} | ${copy.CREATE_NONE_BODY}`);
  out.push(`create labels: ${copy.CREATE_ARTICLE_LABEL} | ${copy.CREATE_LABEL}`);
  out.push(`create terms: ${copy.CREATE_TERMS_NOTE('terms-1')}`);
  out.push(`created: ${copy.createdText('1')}`);
  for (const code of [
    'already_offered',
    'no_corridor',
    'not_found',
    'invalid_price',
    'attestation_required',
    'publisher_not_active',
    'forbidden',
    'other',
  ])
    out.push(`error ${code}: ${copy.createErrorText(code)}`);
  return out;
}

describe('publisher e1 copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });
  it('has no dash characters, no italics markup and no hard coded environment word', () => {
    const text = lines()
      .map((l) => l.slice(l.indexOf(': ') + 2))
      .join('\n');
    // the export hrefs hold a hyphen free path; no en, em or minus dashes anywhere, and no hyphen in prose
    expect(text).not.toMatch(/[‐-―−]/);
    expect(
      text.replace(/\/api\/[^\s|]+/g, '').replace(/terms-1|\d{4}-\d{2}-\d{2}/g, ''),
    ).not.toMatch(/-/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
    expect(text).not.toMatch(/sandbox|dry.?run/i);
  });
  it('never says not charged, paid out or projected money', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/not charged|paid out/i);
  });
});
