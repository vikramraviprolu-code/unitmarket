// MC2-L6 (D-083): the words and the pure view of a capture PayPal holds for the seller to accept. The
// buyer words are chosen by a closed kind; a raw reason is never an input. The seller view groups by
// currency and stored environment, names the two choices and offers no automatic action.
import { describe, expect, it } from 'vitest';
import {
  AWAITING_SELLER_BUYER_TEXT,
  AWAITING_SELLER_LABEL,
  AWAITING_SELLER_LINE,
  NEW_OFFER_HREF,
  pendingBuyerText,
  pendingItemLine,
  pendingSellerView,
} from './pending-copy';
import type { PendingUnitRow } from './pending-copy';

const row = (over: Partial<PendingUnitRow> = {}): PendingUnitRow => ({
  at: '2026-11-03T10:00:00.000Z',
  order_ref6: 'ABC123',
  amount_minor: 500,
  currency: 'USD',
  environment: 'dryrun',
  kind: 'awaiting_seller_acceptance',
  label: AWAITING_SELLER_LABEL,
  ...over,
});

describe('buyer words', () => {
  it('the awaiting state says what is true and what happens next', () => {
    expect(pendingBuyerText('awaiting_seller_acceptance')).toBe(AWAITING_SELLER_BUYER_TEXT);
    expect(AWAITING_SELLER_BUYER_TEXT).toMatch(/^Awaiting seller acceptance\./);
    expect(AWAITING_SELLER_BUYER_TEXT).toContain('You have not lost money');
    expect(AWAITING_SELLER_BUYER_TEXT).toMatch(/seller accepts/);
    expect(AWAITING_SELLER_BUYER_TEXT).toMatch(/PayPal returns/);
  });
  it('any other pending kind keeps the generic words', () => {
    expect(pendingBuyerText('payment_pending')).toBe('Payment pending at PayPal');
  });
  it('a pack item line is the label with the lock said', () => {
    expect(pendingItemLine('awaiting_seller_acceptance')).toBe(AWAITING_SELLER_LINE);
    expect(pendingItemLine('payment_pending')).toBeNull();
  });
  it('the words have no dash, no italics markup and no raw reason', () => {
    for (const s of [AWAITING_SELLER_BUYER_TEXT, AWAITING_SELLER_LINE, AWAITING_SELLER_LABEL]) {
      expect(s).not.toMatch(/[‐-―−]/);
      expect(s).not.toMatch(/<i>|<em>|\*[a-z]|_[a-z]/i);
      expect(s).not.toMatch(/RECEIVING_PREFERENCE/);
    }
  });
});

describe('seller view', () => {
  it('has no panel and no groups when nothing is pending', () => {
    const v = pendingSellerView([]);
    expect(v).toEqual({ groups: [], rows: [], panel: null });
  });

  it('groups count and amount per currency and environment, in a stable order', () => {
    const v = pendingSellerView([
      row({ amount_minor: 500 }),
      row({ currency: 'EUR', amount_minor: 450, order_ref6: 'EUR001' }),
      row({ currency: 'EUR', amount_minor: 150, order_ref6: 'EUR002' }),
      row({ amount_minor: 250, kind: 'payment_pending', label: 'Payment pending at PayPal' }),
    ]);
    expect(v.groups.map((g) => [g.currency, g.environment, g.count, g.minor])).toEqual([
      ['EUR', 'dryrun', 2, 600],
      ['USD', 'dryrun', 2, 750],
    ]);
    expect(v.groups.map((g) => g.text)).toEqual(['2 payments, €6.00', '2 payments, $7.50']);
    expect(v.rows).toHaveLength(4);
  });

  it('a single payment is said in the singular', () => {
    expect(pendingSellerView([row()]).groups[0]!.text).toBe('1 payment, $5.00');
  });

  it('keeps dry run and sandbox apart', () => {
    const v = pendingSellerView([row(), row({ environment: 'sandbox' })]);
    expect(v.groups.map((g) => g.environment)).toEqual(['dryrun', 'sandbox']);
  });

  it('shows the panel with exactly the two D-083 choices when a unit awaits acceptance', () => {
    const v = pendingSellerView([row()]);
    expect(v.panel).not.toBeNull();
    const p = v.panel!;
    expect(p.choices.map((c) => c.id)).toEqual(['wait', 'other_currency']);
    expect(p.choices[0]!.title).toBe('Wait');
    expect(p.choices[1]!.title).toBe('List an offer in another currency');
    expect(p.choices[1]!.href).toBe(NEW_OFFER_HREF);
    expect(p.choices[1]!.href).toBe('/publisher/offers/new');
    expect(p.choices[0]!.href).toBeNull();
    expect(p.closing).toMatch(/does not convert/);
    expect(p.closing).toMatch(/until you choose/);
  });

  it('shows no panel when the pending units are all of the generic kind', () => {
    const v = pendingSellerView([
      row({ kind: 'payment_pending', label: 'Payment pending at PayPal' }),
    ]);
    expect(v.rows).toHaveLength(1);
    expect(v.panel).toBeNull();
  });

  it('the panel counts only the units that await acceptance', () => {
    const v = pendingSellerView([
      row(),
      row({ kind: 'payment_pending', label: 'Payment pending at PayPal' }),
    ]);
    expect(v.panel!.awaiting_count).toBe(1);
  });

  it('the panel words have no dash, no italics markup and no raw reason', () => {
    const p = pendingSellerView([row()]).panel!;
    const text = [
      p.heading,
      p.intro,
      p.closing,
      ...p.choices.flatMap((c) => [c.title, c.body, c.link_text ?? '']),
    ].join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    expect(text).not.toMatch(/RECEIVING_PREFERENCE/);
  });
});
