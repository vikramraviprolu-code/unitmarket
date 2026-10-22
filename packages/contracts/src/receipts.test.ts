import { describe, expect, it } from 'vitest';
import { ReceiptLineSchema, ReceiptSchema } from './receipts';

const window = {
  state: 'not_started',
  started_at: null,
  base_ends_at: null,
  ends_at: null,
  paused_at: null,
  credit_ms: 0,
};
const line = {
  article_id: 'art_1',
  article_sha256: 'a'.repeat(64),
  option: 'keep_retrieve',
  amount_minor: 300,
  capture_id: null,
  window,
  delivery: [{ kind: 'link_issued', at: '2026-10-21T10:00:00Z' }],
};
describe('receipts', () => {
  it('ReceiptLine', () => {
    expect(ReceiptLineSchema.safeParse(line).success).toBe(true);
    expect(
      ReceiptLineSchema.safeParse({
        ...line,
        delivery: [{ kind: 'nope', at: '2026-10-21T10:00:00Z' }],
      }).success,
    ).toBe(false);
  });
  it('Receipt', () => {
    const policy = {
      id: 'pol_1',
      version: '1',
      option: 'keep_retrieve',
      window_ms: 432000000,
      start_rule: 'payment_verified_and_delivery_ready',
    };
    const rights = { scope: 'personal_use', ai_scope: 'agent_allowed', redistribution: false };
    const snapshot = {
      snapshot_version: '1',
      items: [
        {
          article_id: 'art_1',
          article_sha256: 'a'.repeat(64),
          offer_id: 'ofr_1',
          offer_version: '1',
          terms_version: 't',
          publisher_id: 'pub_1',
          payee_merchant_id: 'M1',
          option: 'keep_retrieve',
          policy,
          rights,
          amount_minor: 300,
        },
      ],
      publishers: [
        {
          publisher_id: 'pub_1',
          payee_merchant_id: 'M1',
          amount_minor: 300,
          platform_fee_minor: 0,
        },
      ],
      total_minor: 300,
      currency: 'USD',
      corridor_id: 'us-usd',
      reader: { buyer_id: 'buy_1' },
      rule_version: 'r',
      pricing_rule_version: 'p',
    };
    const r = {
      receipt_id: 'rct_1',
      order_id: 'ord_1',
      version: 1,
      snapshot,
      content_hash: 'b'.repeat(64),
      lines: [line],
      refunds: [
        { refund_id: 'R1', amount: { currency: 'USD', minor: 1 }, at: '2026-10-21T10:00:00Z' },
      ],
      debug_ids: ['d1'],
      sha256: 'c'.repeat(64),
      created_at: '2026-10-21T10:00:00Z',
      environment: 'sandbox',
    };
    expect(ReceiptSchema.safeParse(r).success).toBe(true);
    expect(ReceiptSchema.safeParse({ ...r, version: 0.5 }).success).toBe(false);
    expect(
      ReceiptSchema.safeParse({ ...r, snapshot: { ...snapshot, total_minor: 1 } }).success,
    ).toBe(false);
  });
});
