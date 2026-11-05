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
    expect(valid({ ...snapshot(), snapshot_version: '3' })).toBe(false);
  });
  it('item schema is strict', () => {
    expect(SnapshotItemSchema.safeParse({ ...item('a', 'p', 'M', 1), extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('ApprovalSnapshot settlement (DP-1, MVP-D)', () => {
  const two = (settlement?: unknown) => ({
    ...snapshot(),
    ...(settlement === undefined ? {} : { settlement }),
  });
  const ok = { route: 'per_publisher', payments: 2 };
  it('settlement only with 2 publishers; payments must equal 2; single route refused', () => {
    // two publishers: settlement is accepted, and so is its absence (a pre-DP-1 stored snapshot)
    expect(valid(two(ok))).toBe(true);
    expect(valid(two())).toBe(true);
    const parsed = ApprovalSnapshotSchema.parse(two(ok));
    expect(parsed.settlement).toEqual({ route: 'per_publisher', payments: 2 });
    // payments must equal the publisher count (2)
    for (const payments of [0, 1, 3, 2.5, '2', null]) {
      expect(valid(two({ route: 'per_publisher', payments })), String(payments)).toBe(false);
    }
    // the single route is refused, and an unknown route
    expect(valid(two({ route: 'single', payments: 2 }))).toBe(false);
    expect(valid(two({ route: 'single', payments: 1 }))).toBe(false);
    expect(valid(two({ route: 'other', payments: 2 }))).toBe(false);
    // the settlement object is strict, and both keys are required
    expect(valid(two({ ...ok, extra: 1 }))).toBe(false);
    expect(valid(two({ route: 'per_publisher' }))).toBe(false);
    expect(valid(two({ payments: 2 }))).toBe(false);
    expect(valid(two(null))).toBe(false);
  });
  it('a settlement on a one-publisher snapshot is refused, even a consistent-looking one', () => {
    const one = {
      ...snapshot(),
      items: [item('art_1', 'pub_1', 'M1', 300), item('art_2', 'pub_1', 'M1', 200)],
      publishers: [pubBlock('pub_1', 'M1', 500)],
      total_minor: 500,
    };
    expect(valid(one)).toBe(true);
    expect(valid({ ...one, settlement: ok })).toBe(false);
    expect(valid({ ...one, settlement: { route: 'per_publisher', payments: 1 } })).toBe(false);
    expect(valid({ ...one, settlement: { route: 'single', payments: 1 } })).toBe(false);
  });
  it('a settlement on a three-publisher snapshot is refused (payments is 2 and the count is 3)', () => {
    const three = {
      ...snapshot(),
      items: [...snapshot().items, item('art_4', 'pub_3', 'M3', 50)],
      publishers: [...snapshot().publishers, pubBlock('pub_3', 'M3', 50)],
      total_minor: 650,
    };
    expect(valid(three)).toBe(true);
    expect(valid({ ...three, settlement: ok })).toBe(false);
    expect(valid({ ...three, settlement: { route: 'per_publisher', payments: 3 } })).toBe(false);
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
  it('M7: refuses an approval whose buyer_id differs from the snapshot reader', () => {
    expect(ApprovalSchema.safeParse({ ...base, buyer_id: 'buy_2' }).success).toBe(false);
    const otherReader = snapshot();
    otherReader.reader.buyer_id = 'buy_9';
    expect(ApprovalSchema.safeParse({ ...base, snapshot: otherReader }).success).toBe(false);
  });
  it('M7: used_at may not be later than expires_at', () => {
    expect(ApprovalSchema.safeParse({ ...base, used_at: '2026-10-21T10:15:00Z' }).success).toBe(
      true,
    );
    expect(ApprovalSchema.safeParse({ ...base, used_at: '2026-10-21T10:15:01Z' }).success).toBe(
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
  const expected = () => ({
    order_ref: 'ord_1',
    buyer_id: 'buy_1',
    content_hash: 'b'.repeat(64),
    currency: 'USD',
    total_minor: 600,
    units: [
      { reference_id: 'unt_1', publisher_id: 'pub_1', payee_merchant_id: 'M1', amount_minor: 500 },
      { reference_id: 'unt_2', publisher_id: 'pub_2', payee_merchant_id: 'M2', amount_minor: 100 },
    ],
    created_at: '2026-10-21T10:00:00Z',
    environment: 'sandbox',
  });
  it('M7: refuses empty units, repeated reference_ids and a total that differs from the unit sum', () => {
    expect(ExpectedTransactionSchema.safeParse(expected()).success).toBe(true);
    expect(ExpectedTransactionSchema.safeParse({ ...expected(), units: [] }).success).toBe(false);
    const dup = expected();
    dup.units[1]!.reference_id = 'unt_1';
    expect(ExpectedTransactionSchema.safeParse(dup).success).toBe(false);
    expect(ExpectedTransactionSchema.safeParse({ ...expected(), total_minor: 601 }).success).toBe(
      false,
    );
    expect(ExpectedTransactionSchema.safeParse({ ...expected(), total_minor: 0 }).success).toBe(
      false,
    );
  });
});

// BR-3: version 2 carries the resolved business terms inside the snapshot (and so inside the content hash).
describe('ApprovalSnapshot terms (BR-3)', () => {
  const terms = (over: Record<string, unknown> = {}) => ({
    rules_version: '1',
    values: { 'refund.request_window': 7, 'access.window': 7, 'mandate.max_days': 90 },
    sources: {
      'refund.request_window': 'default',
      'access.window': 'linked:refund.request_window',
      'mandate.max_days': 'default',
    },
    digest: 'c'.repeat(64),
    ...over,
  });
  const v2 = (t: unknown = terms()) => ({ ...snapshot(), snapshot_version: '2', terms: t });
  const withValues = (values: Record<string, unknown>) =>
    v2(terms({ values: { ...terms().values, ...values } }));

  it('version 2 with strict terms parses; version 1 without terms still parses', () => {
    expect(valid(v2())).toBe(true);
    expect(valid(snapshot())).toBe(true);
    const parsed = ApprovalSnapshotSchema.parse(v2());
    expect(parsed.snapshot_version).toBe('2');
  });
  it('version 2 without terms is refused', () => {
    const { terms: _dropped, ...bare } = v2();
    expect(valid(bare)).toBe(false);
    expect(valid({ ...v2(), terms: undefined })).toBe(false);
    expect(valid(v2(null))).toBe(false);
  });
  it('version 1 with a terms block is refused', () => {
    expect(valid({ ...snapshot(), terms: terms() })).toBe(false);
  });
  it('terms are strict: unknown keys, a wrong rules_version and a bad digest are refused', () => {
    expect(valid(v2(terms({ extra: 1 })))).toBe(false);
    expect(valid(v2(terms({ rules_version: '2' })))).toBe(false);
    expect(valid(v2(terms({ digest: 'xyz' })))).toBe(false);
    expect(valid(withValues({ extra: 1 }))).toBe(false);
  });
  it('each value must sit inside its registry range and be a whole number', () => {
    for (const bad of [
      { 'refund.request_window': -1 },
      { 'refund.request_window': 31 },
      { 'access.window': 0 },
      { 'access.window': 31 },
      { 'mandate.max_days': 0 },
      { 'mandate.max_days': 91 },
      { 'refund.request_window': 7.5 },
    ]) {
      expect(valid(withValues(bad))).toBe(false);
    }
    for (const good of [
      { 'refund.request_window': 0, 'access.window': 1 },
      { 'refund.request_window': 30, 'access.window': 30, 'mandate.max_days': 1 },
    ]) {
      expect(valid(withValues(good))).toBe(true);
    }
  });
  it('access.window may not be shorter than refund.request_window (the link rule)', () => {
    expect(valid(withValues({ 'refund.request_window': 10, 'access.window': 9 }))).toBe(false);
    expect(valid(withValues({ 'refund.request_window': 10, 'access.window': 10 }))).toBe(true);
  });
  it('the snapshot refinements still apply to version 2', () => {
    const s = v2();
    s.total_minor = 599;
    expect(valid(s)).toBe(false);
  });
});
