// API-B: the mandate contracts (additive). A request needs at least one cap, accepted terms and an expiry;
// the view never carries a secret; the switch name, the id prefixes and the snapshot field are additive.
import { describe, expect, it } from 'vitest';
import {
  ApprovalSnapshotSchema,
  BudgetStatusSchema,
  IdPrefixSchema,
  MandateCreateRequestSchema,
  MandateViewSchema,
  SwitchNameSchema,
} from './index';

const base = {
  agent_key_id: 'key_abc',
  currency: 'USD',
  expires_at: '2026-12-04T10:00:00.000Z',
  terms_accepted: true,
};

describe('MandateCreateRequestSchema', () => {
  it('accepts money only, count only, or both, with an optional per-purchase maximum', () => {
    for (const caps of [
      { max_total_minor: 500 },
      { max_count: 3 },
      { max_total_minor: 500, max_count: 3, max_per_purchase_minor: 100 },
    ]) {
      expect(MandateCreateRequestSchema.safeParse({ ...base, ...caps }).success).toBe(true);
    }
  });
  it('needs at least one of money and count', () => {
    expect(MandateCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      MandateCreateRequestSchema.safeParse({ ...base, max_per_purchase_minor: 100 }).success,
    ).toBe(false);
  });
  it('needs terms_accepted: true, a three letter currency and a UTC expiry', () => {
    const ok = { ...base, max_count: 1 };
    expect(MandateCreateRequestSchema.safeParse({ ...ok, terms_accepted: false }).success).toBe(
      false,
    );
    expect(MandateCreateRequestSchema.safeParse({ ...ok, terms_accepted: undefined }).success).toBe(
      false,
    );
    expect(MandateCreateRequestSchema.safeParse({ ...ok, currency: 'usd' }).success).toBe(false);
    expect(MandateCreateRequestSchema.safeParse({ ...ok, expires_at: 'tomorrow' }).success).toBe(
      false,
    );
  });
  it('refuses zero, negative, fractional and oversized caps, and any extra field', () => {
    const ok = { ...base, max_count: 1 };
    for (const bad of [0, -1, 1.5, 2 ** 31]) {
      expect(
        MandateCreateRequestSchema.safeParse({ ...ok, max_total_minor: bad }).success,
        String(bad),
      ).toBe(false);
      expect(
        MandateCreateRequestSchema.safeParse({ ...ok, max_count: bad }).success,
        String(bad),
      ).toBe(false);
    }
    expect(MandateCreateRequestSchema.safeParse({ ...ok, spent_minor: 0 }).success).toBe(false);
  });
});

describe('MandateViewSchema and BudgetStatusSchema', () => {
  it('the view is strict and holds caps, spend, remaining and the expiry', () => {
    const view = {
      id: 'man_abc',
      agent_key_id: 'key_abc',
      currency: 'USD',
      max_total_minor: 500,
      max_count: null,
      max_per_purchase_minor: null,
      expires_at: '2026-12-04T10:00:00.000Z',
      revoked_at: null,
      spent_minor: 0,
      used_count: 0,
      remaining_total_minor: 500,
      remaining_count: null,
      created_at: '2026-11-04T10:00:00.000Z',
    };
    expect(MandateViewSchema.safeParse(view).success).toBe(true);
    expect(MandateViewSchema.safeParse({ ...view, secret: 'x' }).success).toBe(false);
  });
  it('the budget status is active with the remaining figures, or mandate_required with the words to use', () => {
    expect(
      BudgetStatusSchema.safeParse({
        status: 'active',
        mandate_id: 'man_abc',
        currency: 'USD',
        remaining_total_minor: 10,
        remaining_count: null,
        max_per_purchase_minor: null,
        expires_at: '2026-12-04T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      BudgetStatusSchema.safeParse({
        status: 'mandate_required',
        reason: 'none',
        ask_buyer: 'Ask the buyer.',
      }).success,
    ).toBe(true);
    expect(
      BudgetStatusSchema.safeParse({ status: 'mandate_required', reason: 'none' }).success,
    ).toBe(false);
  });
});

describe('additive changes elsewhere in the contracts', () => {
  it('agent_buy_enabled is a switch name', () => {
    expect(SwitchNameSchema.options).toContain('agent_buy_enabled');
    // WEB-IMPORT-SW added web_import_enabled, the eighth switch.
    expect(SwitchNameSchema.options).toHaveLength(8);
  });
  it('mandates and reservations have id prefixes', () => {
    expect(IdPrefixSchema.options).toEqual(expect.arrayContaining(['man', 'rsv']));
  });
  it('a snapshot may carry a mandate_id, and one without it is still valid', () => {
    const snap = (extra: object) => ({
      snapshot_version: '1',
      items: [
        {
          article_id: 'art_1',
          article_sha256: 'a'.repeat(64),
          offer_id: 'ofr_1',
          offer_version: '1',
          terms_version: 't1',
          publisher_id: 'pub_1',
          payee_merchant_id: 'SBXPAYEE0001',
          option: 'keep_retrieve',
          policy: {
            id: 'keep_retrieve',
            version: '1',
            option: 'keep_retrieve',
            window_ms: 432_000_000,
            start_rule: 'payment_verified_and_delivery_ready',
          },
          rights: { scope: 'personal_use', ai_scope: 'agent_allowed', redistribution: false },
          amount_minor: 10,
        },
      ],
      publishers: [
        {
          publisher_id: 'pub_1',
          payee_merchant_id: 'SBXPAYEE0001',
          amount_minor: 10,
          platform_fee_minor: 0,
        },
      ],
      total_minor: 10,
      currency: 'USD',
      corridor_id: 'off-usd',
      reader: { buyer_id: 'buy_1' },
      rule_version: 'r1',
      pricing_rule_version: 'p1',
      ...extra,
    });
    expect(ApprovalSnapshotSchema.safeParse(snap({})).success).toBe(true);
    expect(ApprovalSnapshotSchema.safeParse(snap({ mandate_id: 'man_abc' })).success).toBe(true);
    expect(ApprovalSnapshotSchema.safeParse(snap({ mandate_id: 42 })).success).toBe(false);
  });
});
