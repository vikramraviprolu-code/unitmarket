import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  ApprovalSchema,
  ApprovalSnapshotSchema,
  ExpectedTransactionSchema,
  SnapshotItemSchema,
  SnapshotPublisherSchema,
} from './approval';

const policy = {
  id: 'pol_1',
  version: '1',
  option: 'keep_retrieve',
  window_ms: 432000000,
  start_rule: 'payment_verified_and_delivery_ready',
};
const rights = { scope: 'personal_use', ai_scope: 'agent_allowed', redistribution: false };
const item = (article: string, pub: string, payee: string, amount: number) => ({
  article_id: article,
  article_sha256: 'a'.repeat(64),
  offer_id: 'ofr_1',
  offer_version: '1',
  terms_version: 't1',
  publisher_id: pub,
  payee_merchant_id: payee,
  option: 'keep_retrieve',
  policy,
  rights,
  amount_minor: amount,
});
const pubBlock = (pub: string, payee: string, amount: number) => ({
  publisher_id: pub,
  payee_merchant_id: payee,
  amount_minor: amount,
  platform_fee_minor: 0,
});
const snapshot = () => ({
  snapshot_version: '1',
  items: [
    item('art_1', 'pub_1', 'M1', 300),
    item('art_2', 'pub_1', 'M1', 200),
    item('art_3', 'pub_2', 'M2', 100),
  ],
  publishers: [pubBlock('pub_1', 'M1', 500), pubBlock('pub_2', 'M2', 100)],
  total_minor: 600,
  currency: 'USD',
  corridor_id: 'us-usd',
  reader: { buyer_id: 'buy_1' },
  rule_version: 'r1',
  pricing_rule_version: 'p1',
});
const valid = (s: unknown) => ApprovalSnapshotSchema.safeParse(s).success;

describe('ApprovalSnapshot refinements', () => {
  it('accepts a consistent snapshot', () => {
    expect(valid(snapshot())).toBe(true);
  });
  it('refuses a duplicate article (A-08)', () => {
    const s = snapshot();
    s.items[1] = item('art_1', 'pub_1', 'M1', 200);
    expect(valid(s)).toBe(false);
  });
  it('refuses a payee that differs from the publisher block (A-09)', () => {
    const s = snapshot();
    s.items[2] = item('art_3', 'pub_2', 'M9', 100);
    expect(valid(s)).toBe(false);
  });
  it('refuses an item whose publisher has no block, and a block with no items', () => {
    const s = snapshot();
    s.items[2] = item('art_3', 'pub_3', 'M2', 100);
    expect(valid(s)).toBe(false);
    const t = snapshot();
    t.items = t.items.slice(0, 2);
    t.total_minor = 600;
    expect(valid(t)).toBe(false);
  });
  it('refuses a publisher amount that differs from its item sum', () => {
    const s = snapshot();
    s.publishers[0] = pubBlock('pub_1', 'M1', 501);
    s.total_minor = 601;
    expect(valid(s)).toBe(false);
  });
  it('refuses a total that differs from the publisher sum', () => {
    const s = snapshot();
    s.total_minor = 599;
    expect(valid(s)).toBe(false);
  });
  it('refuses a second currency (per-item currency is an unknown key; bad code refused)', () => {
    const s = snapshot();
    (s.items[0] as Record<string, unknown>).currency = 'EUR';
    expect(valid(s)).toBe(false);
    const t = snapshot();
    t.currency = 'usd';
    expect(valid(t)).toBe(false);
  });
  it('refuses duplicate publishers, empty items, a nonzero platform fee, wrong version', () => {
    const s = snapshot();
    s.publishers.push(pubBlock('pub_1', 'M1', 0));
    expect(valid(s)).toBe(false);
    expect(valid({ ...snapshot(), items: [] })).toBe(false);
    expect(
      SnapshotPublisherSchema.safeParse({ ...pubBlock('p', 'M', 1), platform_fee_minor: 1 })
        .success,
    ).toBe(false);
    expect(valid({ ...snapshot(), snapshot_version: '2' })).toBe(false);
  });
  it('item schema is strict', () => {
    expect(SnapshotItemSchema.safeParse({ ...item('a', 'p', 'M', 1), extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('Approval', () => {
  const base = {
    approval_id: 'apr_1',
    buyer_id: 'buy_1',
    snapshot: snapshot(),
    content_hash: 'b'.repeat(64),
    nonce: 'c'.repeat(32),
    created_at: '2026-10-21T10:00:00Z',
    expires_at: '2026-10-21T10:15:00Z',
    used_at: null,
    environment: 'dryrun',
  };
  it('Approval expires_at equals created_at + 15 min', () => {
    expect(APPROVAL_TTL_MS).toBe(900000);
    expect(ApprovalSchema.safeParse(base).success).toBe(true);
    expect(ApprovalSchema.safeParse({ ...base, expires_at: '2026-10-21T10:15:01Z' }).success).toBe(
      false,
    );
    expect(ApprovalSchema.safeParse({ ...base, expires_at: '2026-10-21T10:14:59Z' }).success).toBe(
      false,
    );
    expect(ApprovalSchema.safeParse({ ...base, expires_at: '2026-10-21T11:00:00Z' }).success).toBe(
      false,
    );
  });
  it('refuses live environment, short nonce, extras', () => {
    expect(ApprovalSchema.safeParse({ ...base, environment: 'live' }).success).toBe(false);
    expect(ApprovalSchema.safeParse({ ...base, nonce: 'abc' }).success).toBe(false);
    expect(ApprovalSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('ExpectedTransaction', () => {
  it('validates', () => {
    const e = {
      order_ref: 'ord_1',
      buyer_id: 'buy_1',
      content_hash: 'b'.repeat(64),
      currency: 'USD',
      total_minor: 600,
      units: [
        {
          reference_id: 'unt_1',
          publisher_id: 'pub_1',
          payee_merchant_id: 'M1',
          amount_minor: 600,
        },
      ],
      created_at: '2026-10-21T10:00:00Z',
      environment: 'sandbox',
    };
    expect(ExpectedTransactionSchema.safeParse(e).success).toBe(true);
    expect(
      ExpectedTransactionSchema.safeParse({ ...e, units: [{ ...e.units[0], extra: 1 }] }).success,
    ).toBe(false);
  });
});
