import { describe, expect, it } from 'vitest';
import {
  AccessOptionSchema,
  AccessPolicySchema,
  AffordabilitySchema,
  ArticleFactsSchema,
  OfferSchema,
  PublisherFactsSchema,
  RightsSchema,
} from './catalogue';

const rights = { scope: 'personal_use', ai_scope: 'review', redistribution: false };
const offer = {
  id: 'ofr_1',
  version: '1',
  publisher_id: 'pub_1',
  article_id: 'art_1',
  status: 'authorised',
  currency: 'USD',
  options: [{ option: 'keep_retrieve', price_minor: 300, policy_id: 'pol_1', policy_version: '1' }],
  affordability: { renegotiation_allowed: true, floor_minor: 100 },
  terms_version: 't1',
  rights,
  valid_from: '2026-10-21T10:00:00Z',
  valid_until: null,
  superseded_by: null,
};
describe('catalogue', () => {
  it('AccessOption has two values', () => {
    expect([...AccessOptionSchema.options]).toEqual(['keep_retrieve', 'online_read']);
  });
  it('Rights is personal use, no redistribution', () => {
    expect(RightsSchema.safeParse(rights).success).toBe(true);
    expect(RightsSchema.safeParse({ ...rights, redistribution: true }).success).toBe(false);
    expect(RightsSchema.safeParse({ ...rights, scope: 'commercial' }).success).toBe(false);
  });
  it('AccessPolicy', () => {
    const p = {
      id: 'pol_1',
      version: '1',
      option: 'online_read',
      window_ms: 432000000,
      start_rule: 'payment_verified_and_delivery_ready',
    };
    expect(AccessPolicySchema.safeParse(p).success).toBe(true);
    expect(AccessPolicySchema.safeParse({ ...p, window_ms: 0 }).success).toBe(false);
    expect(AccessPolicySchema.safeParse({ ...p, start_rule: 'on_click' }).success).toBe(false);
  });
  it('Offer validates; status and extras enforced', () => {
    expect(OfferSchema.safeParse(offer).success).toBe(true);
    expect(OfferSchema.safeParse({ ...offer, status: 'live' }).success).toBe(false);
    expect(OfferSchema.safeParse({ ...offer, extra: 1 }).success).toBe(false);
    expect(
      OfferSchema.safeParse({ ...offer, options: [{ ...offer.options[0], price_minor: 1.5 }] })
        .success,
    ).toBe(false);
  });
  it('Affordability, ArticleFacts, PublisherFacts', () => {
    expect(
      AffordabilitySchema.safeParse({ renegotiation_allowed: false, floor_minor: null }).success,
    ).toBe(true);
    expect(
      ArticleFactsSchema.safeParse({
        id: 'art_1',
        publisher_id: 'pub_1',
        title: 't',
        abstract: 'a',
        language: 'en',
        topics: ['x'],
        published_at: '2026-10-21T10:00:00Z',
        sha256: 'a'.repeat(64),
        content_key: 'k',
      }).success,
    ).toBe(true);
    expect(
      PublisherFactsSchema.safeParse({
        id: 'pub_1',
        slug: 's',
        display_name: 'D',
        country: 'US',
        payee_merchant_id: null,
        payee_verified_at: null,
      }).success,
    ).toBe(true);
  });
});
