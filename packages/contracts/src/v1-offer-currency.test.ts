// OFFER-CUR (docs/specs/catalogue-offer-currency.md): the seller create request takes an optional currency of
// USD, EUR or GBP, and stays strict.
import { describe, expect, it } from 'vitest';
import { SellerOfferCreateRequestSchema } from './v1';

const base = {
  article_id: 'art_x',
  options: [{ option: 'online_read', price_minor: 100 }],
  attestation: true,
};

describe('SellerOfferCreateRequestSchema currency', () => {
  it('is optional: a request without it still parses, and gives no currency key', () => {
    const r = SellerOfferCreateRequestSchema.parse(base);
    expect('currency' in r).toBe(false);
  });
  it.each(['USD', 'EUR', 'GBP'])('accepts %s', (c) => {
    expect(SellerOfferCreateRequestSchema.parse({ ...base, currency: c }).currency).toBe(c);
  });
  it.each(['JPY', 'usd', 'US', 'USDX', '', 1, null, ['USD']])('refuses %j', (c) => {
    expect(SellerOfferCreateRequestSchema.safeParse({ ...base, currency: c }).success).toBe(false);
  });
  it('is still strict: an unknown field is refused', () => {
    expect(
      SellerOfferCreateRequestSchema.safeParse({ ...base, publisher_id: 'pub_x' }).success,
    ).toBe(false);
  });
});
