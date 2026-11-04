// MC2-L6 golden (D-083): every word the buyer and the seller are told about a payment PayPal holds for
// the seller to accept. The reviewed file is golden/pending-copy.golden.txt. D-051: no italics, no dashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/pending-copy';

const golden = readFileSync(new URL('./golden/pending-copy.golden.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l !== '' && !l.startsWith('#'));

function lines(): string[] {
  const view = copy.pendingSellerView([
    {
      at: '2026-11-03T10:00:00.000Z',
      order_ref6: 'ABC123',
      amount_minor: 500,
      currency: 'USD',
      environment: 'dryrun',
      kind: 'awaiting_seller_acceptance',
      label: copy.AWAITING_SELLER_LABEL,
    },
  ]);
  const p = view.panel!;
  return [
    `label: ${copy.AWAITING_SELLER_LABEL}`,
    `buyer, order page and library: ${copy.pendingBuyerText('awaiting_seller_acceptance')}`,
    `buyer, other pending reason: ${copy.pendingBuyerText('payment_pending')}`,
    `buyer, pack item line: ${copy.pendingItemLine('awaiting_seller_acceptance')}`,
    `seller, heading: ${copy.PENDING_HEADING}`,
    `seller, lede: ${copy.PENDING_LEDE}`,
    `seller, columns: ${copy.PENDING_COLUMNS.date} | ${copy.PENDING_COLUMNS.order} | ${copy.PENDING_COLUMNS.amount} | ${copy.PENDING_COLUMNS.reason}`,
    `seller, group: ${view.groups[0]!.text}`,
    `seller, panel heading: ${p.heading}`,
    `seller, panel intro: ${p.intro}`,
    `seller, choice wait: ${p.choices[0]!.title}. ${p.choices[0]!.body}`,
    `seller, choice other currency: ${p.choices[1]!.title}. ${p.choices[1]!.body} [${p.choices[1]!.link_text}]`,
    `seller, panel closing: ${p.closing}`,
    `operator, exposure line: ${copy.COL_AWAITING}`,
  ];
}

describe('pending copy (golden)', () => {
  it('matches golden/pending-copy.golden.txt', () => {
    expect(lines()).toEqual(golden);
  });

  it('has no dash characters and no italics markup', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
  });
});
