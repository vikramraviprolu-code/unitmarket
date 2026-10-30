// PUB-B golden: every string the offers list (S2) and the offer page (S3) show. Static lines come from
// lib/offer-copy.ts; the variable lines are pinned for each state. The reviewed file is
// golden/offer-copy.golden.txt. D-051: no italics, no dashes. The environment word is never typed in the
// copy file: the pages take it from the stored environment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/offer-copy';

const golden = readFileSync(new URL('./golden/offer-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`s2 heading: ${copy.OFFERS_HEADING}`);
  out.push(`s2 lede: ${copy.OFFERS_LEDE}`);
  out.push(
    `s2 columns: ${copy.COL_ARTICLE} | ${copy.COL_OPTIONS} | ${copy.COL_STATUS} | ${copy.COL_ACTION}`,
  );
  out.push(`s2 empty: ${copy.OFFERS_EMPTY_TITLE} | ${copy.OFFERS_EMPTY_BODY}`);
  for (const s of ['authorised', 'withdrawn', 'draft'] as const)
    out.push(`status ${s}: ${copy.offerStatusText(s)}`);
  out.push(`option keep: ${copy.optionPriceText('keep_retrieve', 100, 'USD')}`);
  out.push(`option read: ${copy.optionPriceText('online_read', 250, 'USD')}`);
  out.push(`option read gbp: ${copy.optionPriceText('online_read', 90, 'GBP')}`);
  out.push(`not offered: ${copy.NOT_OFFERED}`);
  out.push(`edit link: ${copy.editLinkText('Tide tables')}`);
  out.push(`s3 back: ${copy.BACK_TO_OFFERS}`);
  out.push(`s3 lede: ${copy.OFFER_LEDE}`);
  out.push(
    `s3 labels: ${copy.LABEL_ARTICLE} | ${copy.LABEL_STATUS} | ${copy.LABEL_VERSION} | ${copy.LABEL_CURRENCY}`,
  );
  out.push(`s3 options heading: ${copy.OPTIONS_HEADING}`);
  out.push(
    `s3 offered: ${copy.offeredLabel('keep_retrieve')} | ${copy.offeredLabel('online_read')}`,
  );
  out.push(
    `s3 price: ${copy.priceLabel('keep_retrieve', 'USD')} | ${copy.priceLabel('online_read', 'GBP')}`,
  );
  out.push(`s3 price hint: ${copy.priceHint('$1.00', '$20.00')}`);
  out.push(`s3 window: ${copy.LABEL_WINDOW} | ${copy.WINDOW_VALUE}`);
  out.push(
    `s3 licence: ${copy.LABEL_LICENCE} | ${copy.licenceText({ scope: 'personal_use', ai_scope: 'agent_allowed', redistribution: false })}`,
  );
  out.push(
    `s3 licence review: ${copy.licenceText({ scope: 'personal_use', ai_scope: 'review', redistribution: false })}`,
  );
  out.push(
    `s3 licence none: ${copy.licenceText({ scope: 'personal_use', ai_scope: 'not_allowed', redistribution: false })}`,
  );
  out.push(`s3 terms: ${copy.LABEL_TERMS}`);
  out.push(`s3 attest: ${copy.ATTEST_LABEL}`);
  out.push(`s3 save: ${copy.SAVE_LABEL}`);
  out.push(`s3 saved: ${copy.savedText('3')}`);
  out.push(`s3 freeze note: ${copy.FREEZE_NOTE}`);
  out.push(`s3 withdrawn notice: ${copy.WITHDRAWN_NOTICE}`);
  out.push(`s3 draft notice: ${copy.DRAFT_NOTICE}`);
  out.push(`s3 withdraw heading: ${copy.WITHDRAW_HEADING}`);
  out.push(`s3 withdraw lede: ${copy.WITHDRAW_LEDE}`);
  out.push(`s3 withdraw reason: ${copy.WITHDRAW_REASON_LABEL}`);
  out.push(`s3 withdraw submit: ${copy.WITHDRAW_LABEL}`);
  out.push(`s3 withdrawn: ${copy.WITHDRAWN_DONE}`);
  out.push(`s3 history heading: ${copy.HISTORY_HEADING}`);
  out.push(
    `s3 history: ${copy.historyLine({ version: '2', status: 'authorised', when: 'WHEN', prices: ['$1.00', '$2.50'] })}`,
  );
  out.push(
    `s3 history withdrawn: ${copy.historyLine({ version: '3', status: 'withdrawn', when: 'WHEN', prices: [] })}`,
  );
  for (const c of [
    'conflict',
    'invalid_price',
    'invalid_options',
    'attestation_required',
    'invalid_reason',
    'withdrawn',
    'not_live',
    'publisher_not_active',
    'not_found',
    'forbidden',
  ] as const)
    out.push(`error ${c}: ${copy.offerErrorText(c)}`);
  out.push(`error unknown: ${copy.offerErrorText('something_else')}`);
  for (const t of [
    '2.50',
    '1',
    '1.5',
    '0.99',
    '20.00',
    '20.01',
    '',
    'abc',
    '1,50',
    '-1',
    '1.505',
    ' 2 ',
    '００1',
  ])
    out.push(`parse "${t}": ${String(copy.parsePriceMinor(t))}`);
  for (const m of [100, 250, 5, 2000]) out.push(`input ${String(m)}: ${copy.priceInputValue(m)}`);
  return out;
}

describe('offer copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });
  it('has no dash characters, no italics markup and no hard coded environment word', () => {
    const text = lines()
      .filter((l) => !l.startsWith('parse '))
      .map((l) => l.slice(l.indexOf(': ') + 2))
      .join('\n');
    expect(text).not.toMatch(/[‐-―−-]/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
    expect(text).not.toMatch(/sandbox|dry.?run/i);
  });
  it('says the freeze sentence word for word', () => {
    expect(copy.FREEZE_NOTE).toBe('Buyers who already approved keep the price they saw.');
    expect(copy.WINDOW_VALUE).toBe('Set by UnitMarket');
  });
  it('parsePriceMinor accepts only whole or two digit decimal amounts', () => {
    expect(copy.parsePriceMinor('2.50')).toBe(250);
    expect(copy.parsePriceMinor('1')).toBe(100);
    expect(copy.parsePriceMinor('1.5')).toBe(150);
    expect(copy.parsePriceMinor('1.505')).toBeNull();
    expect(copy.parsePriceMinor('1,50')).toBeNull();
    expect(copy.parsePriceMinor('-1')).toBeNull();
    expect(copy.parsePriceMinor('')).toBeNull();
  });
});
