// UX-1A addendum, items 45 and 54: the shape of the buyer receipt JSON is pinned as a list of key paths.
// A new key, or a merchant key coming back, shows up here as a diff for a human to read.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './support';
import { bootRefundWorld, buy } from './refund-support';
import type { RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
let order_id: string;

beforeAll(async () => {
  w = await bootRefundWorld();
  order_id = (await buy(w, { offer: 'ferry-timetables', option: 'online_read' })).order_id;
});
afterAll(async () => {
  await w.app.close();
});

const paths = (v: unknown, prefix = '', out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => paths(x, `${prefix}[]`, out));
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      const p = prefix === '' ? k : `${prefix}.${k}`;
      out.add(p);
      paths(x, p, out);
    }
  return out;
};

describe('buyer receipt key paths', () => {
  it('are exactly these', async () => {
    const res = await call(w.receipts.GET, {
      url: `/api/receipts/${order_id}`,
      session: w.A,
      params: { order: order_id },
    });
    // The policy and rights blocks are the offer's own and pinned by their contracts; the rest is listed here.
    const keys = [...paths(await res.json())].filter(
      (k) => !/^snapshot\.items\[\]\.(policy|rights)\./.test(k),
    );
    expect(keys.sort()).toEqual([
      'content_hash',
      'created_at',
      'debug_ids',
      'environment',
      'lines',
      'lines[].amount_minor',
      'lines[].article_id',
      'lines[].article_sha256',
      'lines[].capture_id',
      'lines[].delivery',
      'lines[].delivery[].at',
      'lines[].delivery[].kind',
      'lines[].option',
      'lines[].publisher',
      'lines[].title',
      'lines[].window',
      'lines[].window.base_ends_at',
      'lines[].window.credit_ms',
      'lines[].window.ends_at',
      'lines[].window.paused_at',
      'lines[].window.started_at',
      'lines[].window.state',
      'order_id',
      'receipt_id',
      'refunds',
      'sha256',
      'snapshot',
      'snapshot.corridor_id',
      'snapshot.currency',
      'snapshot.items',
      'snapshot.items[].amount_minor',
      'snapshot.items[].article_id',
      'snapshot.items[].article_sha256',
      'snapshot.items[].offer_id',
      'snapshot.items[].offer_version',
      'snapshot.items[].option',
      'snapshot.items[].policy',
      'snapshot.items[].publisher_id',
      'snapshot.items[].rights',
      'snapshot.items[].terms_version',
      'snapshot.pricing_rule_version',
      'snapshot.publishers',
      'snapshot.publishers[].amount_minor',
      'snapshot.publishers[].platform_fee_minor',
      'snapshot.publishers[].publisher_id',
      'snapshot.reader',
      'snapshot.reader.buyer_id',
      'snapshot.rule_version',
      'snapshot.snapshot_version',
      'snapshot.terms',
      'snapshot.terms.digest',
      'snapshot.terms.rules_version',
      'snapshot.terms.sources',
      'snapshot.terms.sources.access.window',
      'snapshot.terms.sources.mandate.max_days',
      'snapshot.terms.sources.refund.request_window',
      'snapshot.terms.values',
      'snapshot.terms.values.access.window',
      'snapshot.terms.values.mandate.max_days',
      'snapshot.terms.values.refund.request_window',
      'snapshot.total_minor',
      'version',
    ]);
  });
});
