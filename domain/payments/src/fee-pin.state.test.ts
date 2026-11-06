// POB-M1 pin: a fee on top must not change how quotes, approvals, orders, browse and discovery read a price. For an
// offer without a fee the approval snapshot, its content hash, the order, the units and the old ledger rows are the
// values the code produced before the fee existed (captured on a clean checkout of main at 04e22fe, BR-3 merged: the snapshot now carries the resolved terms and the window is 7 days). For an offer WITH a fee the same
// numbers read the listed (buyer) price: the fee is invisible to them.
import { afterEach, describe, expect, it } from 'vitest';
import { requestRefund } from './index';
import { OPERATOR, makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import { priced } from './payout-support';

let w: OpsWorld;
afterEach(async () => {
  await w.close();
});

const PIN_HASH = '90ee731e7f86369c5a7ae9ebb09a12cb82859205e66e7e3665cd207e1bf3aba6';
const PIN_SNAPSHOT = {
  items: [
    {
      option: 'keep_retrieve',
      policy: {
        id: 'keep_retrieve',
        option: 'keep_retrieve',
        version: '1+rules',
        window_ms: 604800000,
        start_rule: 'payment_verified_and_delivery_ready',
      },
      rights: { scope: 'personal_use', ai_scope: 'review', redistribution: false },
      offer_id: 'ofr_1',
      article_id: 'art_1',
      amount_minor: 400,
      publisher_id: 'pub_1',
      offer_version: '1',
      terms_version: 'terms-1',
      article_sha256: 'e7618ef5d5d27c60f6cbd31c58a123928929a01cb3831206b1513d579462e2ff',
      payee_merchant_id: 'MERCH1',
    },
    {
      option: 'keep_retrieve',
      policy: {
        id: 'keep_retrieve',
        option: 'keep_retrieve',
        version: '1+rules',
        window_ms: 604800000,
        start_rule: 'payment_verified_and_delivery_ready',
      },
      rights: { scope: 'personal_use', ai_scope: 'review', redistribution: false },
      offer_id: 'ofr_3',
      article_id: 'art_3',
      amount_minor: 400,
      publisher_id: 'pub_2',
      offer_version: '1',
      terms_version: 'terms-1',
      article_sha256: 'e25e4cef02930624d3cc5557364318a6a2ea78f8d5251201ad8381faa1d3bce7',
      payee_merchant_id: 'MERCH2',
    },
  ],
  terms: {
    digest: 'a460f01cc0d7889900c27fe0f07ff998a4966155df5c0c5ee48c001268fdf0a0',
    values: { 'access.window': 7, 'mandate.max_days': 90, 'refund.request_window': 7 },
    sources: {
      'access.window': 'linked:refund.request_window',
      'mandate.max_days': 'default',
      'refund.request_window': 'default',
    },
    rules_version: '1',
  },
  reader: { buyer_id: 'buy_A' },
  currency: 'USD',
  publishers: [
    {
      amount_minor: 400,
      publisher_id: 'pub_1',
      payee_merchant_id: 'MERCH1',
      platform_fee_minor: 0,
    },
    {
      amount_minor: 400,
      publisher_id: 'pub_2',
      payee_merchant_id: 'MERCH2',
      platform_fee_minor: 0,
    },
  ],
  settlement: { route: 'per_publisher', payments: 2 },
  corridor_id: 'us-usd',
  total_minor: 800,
  rule_version: 'rules-1',
  snapshot_version: '2',
  pricing_rule_version: 'pricing-1',
};

async function read() {
  const approval = (
    await w.rows<{ snapshot: unknown; content_hash: string }>(
      'SELECT snapshot, content_hash FROM approvals',
    )
  )[0]!;
  const order = (
    await w.rows<{ expected: unknown; total_minor: number; currency: string; status: string }>(
      'SELECT expected, total_minor, currency, status FROM orders',
    )
  )[0]!;
  const units = await w.rows(
    'SELECT amount_minor, platform_fee_minor, status, capture_id, paypal_fee_minor FROM order_units ORDER BY capture_id',
  );
  const old = await w.rows(
    `SELECT kind, amount_minor, currency, capture_id, refund_id FROM ledger_entries
      WHERE kind IN ('sale', 'paypal_fee', 'refund', 'reversal') ORDER BY capture_id, kind`,
  );
  return { approval, order, units, old };
}

describe('a fee 0 offer reads exactly as before', () => {
  it('approval snapshot, content hash, order and units are the pinned values, and the old ledger rows are unchanged', async () => {
    w = await makeWorld();
    await paid(w, { offers: ['ofr_1', 'ofr_3'] });
    const r = await read();
    expect(r.approval.snapshot).toEqual(PIN_SNAPSHOT);
    expect(r.approval.content_hash).toBe(PIN_HASH);
    expect(r.order).toMatchObject({ total_minor: 800, currency: 'USD', status: 'paid' });
    expect(JSON.stringify(r.order.expected)).toContain('"total_minor":800');
    expect(
      (r.order.expected as { units: { amount_minor: number }[] }).units.map((u) => u.amount_minor),
    ).toEqual([400, 400]);
    expect(r.units).toEqual([
      {
        amount_minor: 400,
        platform_fee_minor: 0,
        status: 'captured_verified',
        capture_id: 'SBXFAKECAP00003',
        paypal_fee_minor: 45,
      },
      {
        amount_minor: 400,
        platform_fee_minor: 0,
        status: 'captured_verified',
        capture_id: 'SBXFAKECAP00004',
        paypal_fee_minor: 45,
      },
    ]);
    expect(r.old).toEqual([
      {
        kind: 'paypal_fee',
        amount_minor: 45,
        currency: 'USD',
        capture_id: 'SBXFAKECAP00003',
        refund_id: null,
      },
      {
        kind: 'sale',
        amount_minor: 400,
        currency: 'USD',
        capture_id: 'SBXFAKECAP00003',
        refund_id: null,
      },
      {
        kind: 'paypal_fee',
        amount_minor: 45,
        currency: 'USD',
        capture_id: 'SBXFAKECAP00004',
        refund_id: null,
      },
      {
        kind: 'sale',
        amount_minor: 400,
        currency: 'USD',
        capture_id: 'SBXFAKECAP00004',
        refund_id: null,
      },
    ]);
  });

  it('the PayPal order is created for the buyer total and the unit amount, with no fee line', async () => {
    w = await makeWorld();
    await paid(w, { offers: ['ofr_1', 'ofr_3'] });
    const created = [...w.paypal.orders.values()].map((o) =>
      o.req.units.map((u) => u.amount.minor),
    );
    expect(created).toEqual([[400], [400]]);
  });
});

describe('a fee offer reads the listed price everywhere a price is read', () => {
  it('quote, approval, order and unit amounts are the listed 400, byte for byte the fee 0 case', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    await priced(w, 'ofr_3', 350, 50);
    await paid(w, { offers: ['ofr_1', 'ofr_3'] });
    const r = await read();
    expect(r.approval.snapshot).toEqual(PIN_SNAPSHOT);
    expect(r.approval.content_hash).toBe(PIN_HASH);
    expect(r.order.total_minor).toBe(800);
    const quotes = await w.rows<{ price_minor: number }>(
      'SELECT price_minor FROM quotes ORDER BY id',
    );
    expect(quotes.map((q) => q.price_minor)).toEqual([400, 400]);
    expect(r.units.map((u) => (u as { amount_minor: number }).amount_minor)).toEqual([400, 400]);
    // the old ledger rows are the same as for fee 0
    expect(r.old).toHaveLength(4);
    expect(r.old.filter((x) => (x as { kind: string }).kind === 'sale')).toHaveLength(2);
  });

  it('the refund an operator asks for is in buyer money: a full refund returns the whole 400', async () => {
    w = await makeWorld();
    await priced(w, 'ofr_1', 360, 40);
    const a = await paid(w);
    const unit = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!.id;
    const r = await requestRefund(w.deps, {
      unit_id: unit,
      amount: null,
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refused');
    const row = await w.rows<{ amount_minor: number }>(
      'SELECT amount_minor FROM refund_requests WHERE id = $1',
      [r.value.refund_request_id],
    );
    expect(row[0]!.amount_minor).toBe(400);
  });
});
