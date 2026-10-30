// PUB-UI-HOME golden: every string of the redesigned publisher home (tiles, account panel, cards, chips and the
// since feed). The reviewed file is golden/publisher-home-copy.golden.txt. D-051: no italics, no dashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/publisher-home-copy';

const golden = readFileSync(
  new URL('./golden/publisher-home-copy.golden.txt', import.meta.url),
  'utf8',
);

const chip = (c: copy.ChipView): string => `${c.tone}/${c.label}`;

function lines(): string[] {
  const out: string[] = [];
  out.push(
    `tiles: ${copy.TILES_LABEL} | ${copy.TILE_UNITS} | ${copy.TILE_UNITS_NOTE} | ${copy.TILE_REFUNDS} | ${copy.TILE_NET}`,
  );
  out.push(`net note: ${copy.TILE_NET_NOTE}`);
  out.push(`no sales: ${copy.NO_SALES_NOTE}`);
  out.push(`other currencies: ${copy.OTHER_CURRENCIES_NOTE}`);
  out.push(`reversals: ${copy.reversalsNote('$1.50')}`);
  out.push(
    `panel: ${copy.ACCOUNT_HEADING} | ${copy.FACT_PAYEE} | ${copy.FACT_SETTLEMENT} | ${copy.FACT_TERMS}`,
  );
  out.push(`cards heading: ${copy.CARDS_LABEL}`);
  out.push(`card offers: ${copy.CARD_OFFERS_BODY}`);
  out.push(`card sales: ${copy.CARD_SALES_BODY}`);
  out.push(`card statement: ${copy.CARD_STATEMENT_BODY}`);
  out.push(`card payout: ${copy.CARD_PAYOUT_BODY}`);
  for (const s of ['active', 'suspended', 'applied'] as const)
    out.push(`status ${s}: ${chip(copy.statusChip(s))}`);
  const none = { last4: null, verified_at: null };
  const wait = { last4: 'AB12', verified_at: null };
  const done = { last4: 'AB12', verified_at: '2026-10-30T10:00:00.000Z' };
  for (const [k, p] of [
    ['none', none],
    ['waiting', wait],
    ['checked', done],
  ] as const)
    out.push(`payee ${k}: ${chip(copy.payeeChip(p))} | ${copy.payeeDetail(p)}`);
  const rec = { accepted_at: '2026-10-30T10:00:00.000Z', terms_version: 'v1' };
  out.push(`terms accepted: ${chip(copy.termsChip(rec))} | ${copy.termsDetail(rec)}`);
  out.push(`terms none: ${chip(copy.termsChip(null))}`);
  for (const c of [
    { new_sales: 1, refunds: 0, operator_offer_changes: 0, payee_decisions: 0 },
    { new_sales: 2, refunds: 1, operator_offer_changes: 3, payee_decisions: 1 },
  ])
    out.push(
      `since ${JSON.stringify(c)}: ${copy
        .sinceItems(c)
        .map((i) => `${chip(i.chip)} ${i.text}`)
        .join(' ; ')}`,
    );
  return out;
}

describe('publisher home copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });
  it('has no dash characters, no italics markup and no typed environment word', () => {
    const text = lines()
      .map((l) => l.slice(l.indexOf(': ') + 2))
      .join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
    const src = readFileSync(new URL('./lib/publisher-home-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/'(Sandbox|Dry run)'/);
  });
});
