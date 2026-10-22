import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@umsbx/approval';
import type { Receipt } from '@umsbx/contracts';
import { receiptBodyHash, renderReceiptHtml, receiptLabel, sanitiseDebugId } from './index';
import type { ReceiptBody } from './index';

const SHA = 'b'.repeat(64);
const snapshot = {
  snapshot_version: '1' as const,
  items: [
    {
      article_id: 'art_1',
      article_sha256: SHA,
      offer_id: 'ofr_1',
      offer_version: '1',
      terms_version: 'terms-1',
      publisher_id: 'pub_1',
      payee_merchant_id: 'MERCH1',
      option: 'keep_retrieve' as const,
      policy: {
        id: 'pol_k',
        version: 'v1',
        option: 'keep_retrieve' as const,
        window_ms: 432_000_000,
        start_rule: 'payment_verified_and_delivery_ready' as const,
      },
      rights: {
        scope: 'personal_use' as const,
        ai_scope: 'review' as const,
        redistribution: false as const,
      },
      amount_minor: 405,
    },
  ],
  publishers: [
    {
      publisher_id: 'pub_1',
      payee_merchant_id: 'MERCH1',
      amount_minor: 405,
      platform_fee_minor: 0 as const,
    },
  ],
  total_minor: 405,
  currency: 'USD',
  corridor_id: 'us-usd',
  reader: { buyer_id: 'buy_A' },
  rule_version: 'rules-1',
  pricing_rule_version: 'pricing-1',
};
const body = (over: Partial<ReceiptBody> = {}): ReceiptBody => ({
  order_id: 'ord_1',
  snapshot,
  content_hash: SHA,
  lines: [
    {
      article_id: 'art_1',
      article_sha256: SHA,
      option: 'keep_retrieve',
      amount_minor: 405,
      capture_id: 'CAP1',
      window: {
        state: 'running',
        started_at: '2026-10-22T10:00:00.000Z',
        base_ends_at: '2026-10-27T10:00:00.000Z',
        ends_at: '2026-10-27T10:00:00.000Z',
        paused_at: null,
        credit_ms: 0,
      },
      delivery: [{ kind: 'access_ready', at: '2026-10-22T10:00:00.000Z' }],
    },
  ],
  refunds: [],
  debug_ids: ['567890'],
  environment: 'dryrun',
  ...over,
});
const asReceipt = (b: ReceiptBody, over: Partial<Receipt> = {}): Receipt => ({
  receipt_id: 'rct_1',
  version: 1,
  sha256: receiptBodyHash(b),
  created_at: '2026-10-22T10:00:00.000Z',
  ...b,
  ...over,
});

describe('receipt body hash', () => {
  it('receipt hash equals sha256 of canonical body', () => {
    const b = body();
    expect(receiptBodyHash(b)).toBe(sha256Hex(canonicalJson(b, 2)));
    expect(receiptBodyHash(b)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not depend on key order and changes with any value', () => {
    const b = body();
    const shuffled = Object.fromEntries(Object.entries(b).reverse()) as unknown as ReceiptBody;
    expect(receiptBodyHash(shuffled)).toBe(receiptBodyHash(b));
    expect(receiptBodyHash(body({ debug_ids: ['567891'] }))).not.toBe(receiptBodyHash(b));
    expect(receiptBodyHash(body({ environment: 'sandbox' }))).not.toBe(receiptBodyHash(b));
    expect(
      receiptBodyHash(
        body({
          refunds: [
            {
              refund_id: 'R1',
              amount: { currency: 'USD', minor: 5 },
              at: '2026-10-22T11:00:00.000Z',
            },
          ],
        }),
      ),
    ).not.toBe(receiptBodyHash(b));
  });
});

describe('sanitiseDebugId', () => {
  it('keeps only the last 6 characters', () => {
    expect(sanitiseDebugId('ABCDEF1234567890')).toBe('567890');
    expect(sanitiseDebugId('abc')).toBe('abc');
  });
});

describe('renderReceiptHtml', () => {
  it('html escapes a title containing <script>', () => {
    const evil = '<script>alert(1)</script>';
    const b = body({
      debug_ids: [evil],
      refunds: [
        { refund_id: evil, amount: { currency: 'USD', minor: 5 }, at: '2026-10-22T11:00:00.000Z' },
      ],
      lines: [{ ...body().lines[0]!, article_id: evil, capture_id: `"${evil}"` }],
    });
    const html = renderReceiptHtml(asReceipt(b, { order_id: evil }), 'Dry run');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/\son\w+=/i);
  });

  it('escapes quotes, ampersands and apostrophes', () => {
    const html = renderReceiptHtml(asReceipt(body({ debug_ids: [`a"b'c&d`] })), 'Sandbox');
    expect(html).toContain('a&quot;b&#39;c&amp;d');
  });

  it('shows the label, the receipt hash, version and formatted amounts', () => {
    const r = asReceipt(body());
    const html = renderReceiptHtml(r, 'Dry run');
    expect(html).toContain('Dry run');
    expect(html).not.toContain('Sandbox');
    expect(html).toContain(r.sha256);
    expect(html).toContain('4.05 USD');
    expect(html).toContain('CAP1');
    expect(html).toContain('567890');
  });

  it('says "sent", never "downloaded", for a completed download', () => {
    const b = body({
      lines: [
        {
          ...body().lines[0]!,
          delivery: [{ kind: 'download_completed', at: '2026-10-22T10:05:00.000Z' }],
        },
      ],
    });
    const html = renderReceiptHtml(asReceipt(b), 'Dry run');
    expect(html).toMatch(/sent/i);
    expect(html).not.toMatch(/downloaded/i);
  });
});

describe('receiptLabel (P16)', () => {
  it('maps the stored environment to the label', () => {
    expect(receiptLabel('dryrun')).toBe('Dry run');
    expect(receiptLabel('sandbox')).toBe('Sandbox');
  });
});
