// UX-1A addendum, items 45 and 54: the buyer receipt is the domain receipt with titles and publisher
// names on its lines and no merchant id anywhere. Pure; the engine fills `facts` from the catalogue.
import { describe, expect, it } from 'vitest';
import type { Receipt } from '@umsbx/contracts';
import { BUYER_RECEIPT_FALLBACK, toBuyerReceipt } from './receipt-view';

const H = (c: string): string => c.repeat(64);
const MERCHANT = 'SBXMERCHANT01';

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: 'rct_1',
    order_id: 'ord_1',
    version: 2,
    snapshot: {
      snapshot_version: '1',
      items: [
        {
          article_id: 'art_tide',
          article_sha256: H('a'),
          offer_id: 'ofr_p_tide',
          offer_version: '1',
          terms_version: 't1',
          publisher_id: 'pub_1',
          payee_merchant_id: MERCHANT,
          option: 'online_read',
          policy: { id: 'pol_1', version: '1' } as never,
          rights: { scope: 'personal_use', ai_scope: 'not_allowed', redistribution: false },
          amount_minor: 40,
        },
      ],
      publishers: [
        {
          publisher_id: 'pub_1',
          payee_merchant_id: MERCHANT,
          amount_minor: 40,
          platform_fee_minor: 0,
        },
      ],
      total_minor: 40,
      currency: 'USD',
      corridor_id: 'us_to_us' as never,
      reader: { buyer_id: 'buy_A' },
      rule_version: 'r1',
      pricing_rule_version: 'p1',
    },
    content_hash: H('b'),
    lines: [
      {
        article_id: 'art_tide',
        article_sha256: H('a'),
        option: 'online_read',
        amount_minor: 40,
        capture_id: 'CAP123',
        window: {
          state: 'running',
          started_at: '2026-10-30T10:00:00.000Z',
          base_ends_at: '2026-11-04T10:00:00.000Z',
          ends_at: '2026-11-04T10:00:00.000Z',
          paused_at: null,
          credit_ms: 0,
        },
        delivery: [],
      },
    ],
    refunds: [],
    debug_ids: ['abc123'],
    sha256: H('c'),
    created_at: '2026-10-30T10:00:01.000Z',
    environment: 'dryrun',
    ...over,
  } as Receipt;
}

const facts = new Map([
  ['art_tide', { title: 'Tide Tables for the Estuary', publisher: 'Harbour Ledger' }],
]);
const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  return out;
};

describe('titles and publisher on every line (item 45)', () => {
  it('puts the article title and the publisher name on the line', () => {
    const b = toBuyerReceipt(receipt(), facts);
    expect(b.lines[0]!.title).toBe('Tide Tables for the Estuary');
    expect(b.lines[0]!.publisher).toBe('Harbour Ledger');
  });

  it('an unknown article gets the plain fallback words, never its id', () => {
    const b = toBuyerReceipt(receipt(), new Map());
    expect(b.lines[0]!.title).toBe(BUYER_RECEIPT_FALLBACK.title);
    expect(b.lines[0]!.publisher).toBe(BUYER_RECEIPT_FALLBACK.publisher);
    expect(BUYER_RECEIPT_FALLBACK.title).not.toMatch(/art_/);
  });

  it('a line that already names its publisher (a pack) keeps that name when the catalogue has none', () => {
    const r = receipt();
    r.lines[0] = { ...r.lines[0]!, publisher_display_name: 'Pack Press', outcome: 'paid' };
    const b = toBuyerReceipt(r, new Map());
    expect(b.lines[0]!.publisher).toBe('Pack Press');
    expect(b.lines[0]!.outcome).toBe('paid');
  });

  it('keeps what the page and the tests read: version, environment, hash, refunds, totals, window', () => {
    const b = toBuyerReceipt(receipt(), facts);
    expect(b.version).toBe(2);
    expect(b.environment).toBe('dryrun');
    expect(b.sha256).toBe(H('c'));
    expect(b.content_hash).toBe(H('b'));
    expect(b.refunds).toEqual([]);
    expect(b.snapshot.currency).toBe('USD');
    expect(b.snapshot.total_minor).toBe(40);
    expect(b.lines[0]!.amount_minor).toBe(40);
    expect(b.lines[0]!.window.ends_at).toBe('2026-11-04T10:00:00.000Z');
  });
});

describe('no merchant id in the buyer receipt (item 54)', () => {
  it('has no key containing "merchant" and no merchant id value at any depth', () => {
    const b = toBuyerReceipt(receipt(), facts);
    expect(keysDeep(b).filter((k) => /merchant|payee/i.test(k))).toEqual([]);
    expect(JSON.stringify(b)).not.toContain(MERCHANT);
  });

  it('does not change the input receipt', () => {
    const r = receipt();
    const before = JSON.stringify(r);
    toBuyerReceipt(r, facts);
    expect(JSON.stringify(r)).toBe(before);
  });
});
