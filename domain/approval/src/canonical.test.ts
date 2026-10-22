import { describe, expect, it } from 'vitest';
import type { ApprovalSnapshot } from '@umsbx/contracts';
import { canonicalJson, contentHash, makeToken, sha256Hex, tokenMatches } from './index';

const policy = (option: 'keep_retrieve' | 'online_read') => ({
  id: option,
  version: '1',
  option,
  window_ms: 432_000_000,
  start_rule: 'payment_verified_and_delivery_ready' as const,
});
const rights = { scope: 'personal_use', ai_scope: 'review', redistribution: false } as const;

function item(n: number, publisher: string, merchant: string, amount: number) {
  return {
    article_id: `art_${n}`,
    article_sha256: String(n).repeat(64),
    offer_id: `ofr_${n}`,
    offer_version: '1',
    terms_version: 'terms-1',
    publisher_id: publisher,
    payee_merchant_id: merchant,
    option: 'keep_retrieve' as const,
    policy: policy('keep_retrieve'),
    rights,
    amount_minor: amount,
  };
}

function sampleSnapshot(): ApprovalSnapshot {
  return {
    snapshot_version: '1',
    items: [
      item(1, 'pub_1', 'MERCH1', 400),
      item(2, 'pub_1', 'MERCH1', 100),
      item(3, 'pub_2', 'MERCH2', 250),
    ],
    publishers: [
      {
        publisher_id: 'pub_1',
        payee_merchant_id: 'MERCH1',
        amount_minor: 500,
        platform_fee_minor: 0,
      },
      {
        publisher_id: 'pub_2',
        payee_merchant_id: 'MERCH2',
        amount_minor: 250,
        platform_fee_minor: 0,
      },
    ],
    total_minor: 750,
    currency: 'USD',
    corridor_id: 'us-usd',
    reader: { buyer_id: 'buy_A' },
    rule_version: 'rules-1',
    pricing_rule_version: 'pricing-1',
  };
}

describe('canonical JSON', () => {
  it('canonical JSON is key-sorted, whitespace-free, minor units as decimal strings, refuses floats and undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: 'x y' } }, 2)).toBe(
      '{"a":{"c":"x y","d":[3,2]},"b":1}',
    );
    expect(canonicalJson({ z: null, y: true, amount_minor: 400 }, 2)).toBe(
      '{"amount_minor":"4.00","y":true,"z":null}',
    );
    expect(canonicalJson({ amount_minor: 405, total_minor: 5 }, 2)).toBe(
      '{"amount_minor":"4.05","total_minor":"0.05"}',
    );
    expect(canonicalJson({ amount_minor: 400 }, 0)).toBe('{"amount_minor":"400"}');
    expect(canonicalJson({ amount_minor: 5 }, 3)).toBe('{"amount_minor":"0.005"}');
    expect(canonicalJson({ amount_minor: 0 }, 2)).toBe('{"amount_minor":"0.00"}');
    expect(canonicalJson([{ price_minor: 1200 }], 2)).toBe('[{"price_minor":"12.00"}]');
    expect(() => canonicalJson({ a: 1.5 }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ amount_minor: 1.5 }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined }, 2)).toThrow(TypeError);
    expect(() => canonicalJson([undefined], 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: -1 }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date(0) }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ a: 10n }, 2)).toThrow(TypeError);
  });

  it('a _minor key keeps a non-number value as it is', () => {
    expect(canonicalJson({ floor_minor: null }, 2)).toBe('{"floor_minor":null}');
  });

  it('escapes strings the way JSON does', () => {
    expect(canonicalJson({ k: 'a"b\n' }, 2)).toBe('{"k":"a\\"b\\n"}');
  });
});

describe('content hash', () => {
  it('hash is independent of item and publisher order', () => {
    const a = sampleSnapshot();
    const b = sampleSnapshot();
    b.items.reverse();
    b.publishers.reverse();
    expect(contentHash(b)).toBe(contentHash(a));
  });

  it('same snapshot same hash', () => {
    expect(contentHash(sampleSnapshot())).toBe(contentHash(sampleSnapshot()));
    expect(contentHash(sampleSnapshot())).toMatch(/^[a-f0-9]{64}$/);
  });

  it('any changed field changes the hash', () => {
    const base = contentHash(sampleSnapshot());
    const edits: ((s: ApprovalSnapshot) => void)[] = [
      (s) => void (s.total_minor += 1),
      (s) => void (s.items[0]!.amount_minor += 1),
      (s) => void (s.items[0]!.payee_merchant_id = 'MERCHX'),
      (s) => void (s.items[0]!.offer_version = '2'),
      (s) => void (s.items[0]!.option = 'online_read'),
      (s) => void (s.items[0]!.policy.window_ms += 1),
      (s) => void (s.items[0]!.rights = { ...s.items[0]!.rights, ai_scope: 'not_allowed' }),
      (s) => void (s.reader.buyer_id = 'buy_B'),
      (s) => void (s.rule_version = 'rules-2'),
      (s) => void (s.pricing_rule_version = 'pricing-2'),
      (s) => void (s.corridor_id = 'eu-eur'),
      (s) => void (s.currency = 'EUR'),
    ];
    for (const edit of edits) {
      const s = sampleSnapshot();
      edit(s);
      expect(contentHash(s)).not.toBe(base);
    }
  });

  it('does not reorder the caller snapshot', () => {
    const s = sampleSnapshot();
    s.items.reverse();
    const ids = s.items.map((i) => i.article_id);
    contentHash(s);
    expect(s.items.map((i) => i.article_id)).toEqual(ids);
  });

  it('refuses a currency it has no minor-unit exponent for', () => {
    const s = sampleSnapshot();
    s.currency = 'XXX';
    expect(() => contentHash(s)).toThrow(TypeError);
  });

  it('sha256 matches the published test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('token', () => {
  const parts = {
    approval_id: 'apr_1',
    nonce: 'n'.repeat(32),
    content_hash: 'c'.repeat(64),
    expires_at: '2026-10-22T10:15:00.000Z',
  };
  it('has the shape approval_id.hex and verifies against the same parts', () => {
    const t = makeToken('1'.repeat(32), parts);
    expect(t).toMatch(/^apr_1\.[a-f0-9]{64}$/);
    expect(tokenMatches('1'.repeat(32), parts, t)).toBe(true);
  });
  it('fails for another secret, another part, a bad shape or a different id', () => {
    const secret = '1'.repeat(32);
    const t = makeToken(secret, parts);
    expect(tokenMatches('2'.repeat(32), parts, t)).toBe(false);
    for (const k of ['nonce', 'content_hash', 'expires_at', 'approval_id'] as const) {
      expect(tokenMatches(secret, { ...parts, [k]: parts[k] + 'x' }, t)).toBe(false);
    }
    expect(tokenMatches(secret, parts, 'apr_1')).toBe(false);
    expect(tokenMatches(secret, parts, '')).toBe(false);
    expect(tokenMatches(secret, parts, 'apr_2.' + t.split('.')[1])).toBe(false);
    expect(tokenMatches(secret, parts, t.slice(0, -1))).toBe(false);
    expect(tokenMatches(secret, parts, t + '0')).toBe(false);
  });
});
