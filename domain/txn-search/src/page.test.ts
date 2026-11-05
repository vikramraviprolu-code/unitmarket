// INT-SR1: the pure parts of page.ts. Row to line mapping per role, CSV headers and cells, the query hash.
import { describe, expect, it } from 'vitest';
import { buyerLine, exportName, opsLine, queryHash, sellerLine, txnCsv } from './page';
import type { TxnRow } from './sql';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const row = (over: Record<string, unknown> = {}): TxnRow =>
  ({
    unit_id: 'u1',
    order_ref: 'UM-AAAAAA123456',
    order_ref6: '123456',
    order_status: 'paid',
    unit_status: 'verified',
    unit_updated_at: '2026-11-05T10:00:00.000Z',
    created_at: '2026-11-05T09:00:00.000Z',
    captured_verified_at: '2026-11-05T09:30:00.000Z',
    currency: 'USD',
    amount_minor: 250,
    order_total_minor: 500,
    refunded_minor: 0,
    environment: 'sandbox',
    titles: ['Alpha', 'Beta'],
    refund_state: null,
    refund_amount_minor: null,
    case_state: null,
    case_kind: null,
    channel: 'agent',
    agent_key_id: 'key1',
    publisher_id: 'pub1',
    buyer_id: 'buy1',
    mandate_id: 'man1',
    alert_count: 3,
    has_unknown_op: true,
    order_mismatch: true,
    seller_name: 'Quay',
    seller_slug: 'quay',
    buyer_display_name: 'Vera',
    provider_order_id: 'PO1',
    capture_id: 'CAP1',
    refund_id: 'RF1',
    ...over,
  }) as unknown as TxnRow;

describe('lines', () => {
  it('maps environment and channel from the row, and falls back to dryrun and human', () => {
    expect(sellerLine(row(), NOW).environment).toBe('sandbox');
    expect(sellerLine(row(), NOW).channel).toBe('agent');
    expect(sellerLine(row({ environment: 'dryrun', channel: 'human' }), NOW).environment).toBe(
      'dryrun',
    );
    expect(sellerLine(row({ environment: 'x', channel: 'x' }), NOW)).toMatchObject({
      environment: 'dryrun',
      channel: 'human',
    });
  });

  it('the seller line leaves out buyer, key, mandate and the order total', () => {
    const l = sellerLine(row(), NOW) as unknown as Record<string, unknown>;
    for (const k of [
      'buyer_id',
      'agent_key_id',
      'mandate_id',
      'order_total_minor',
      'buyer_display_name',
    ])
      expect(l[k]).toBeUndefined();
  });

  it('the ops line carries flags as booleans only for true, and ids without identity', () => {
    const on = opsLine(row(), NOW, false);
    expect(on).toMatchObject({ has_unknown_op: true, order_mismatch: true, alert_count: 3 });
    const off = opsLine(row({ has_unknown_op: false, order_mismatch: false }), NOW, false);
    expect(off).toMatchObject({ has_unknown_op: false, order_mismatch: false });
    const odd = opsLine(row({ has_unknown_op: 'true', order_mismatch: 1 }), NOW, false);
    expect(odd).toMatchObject({ has_unknown_op: false, order_mismatch: false });
    expect((on as unknown as Record<string, unknown>)['seller_name']).toBeUndefined();
    expect((on as unknown as Record<string, unknown>)['provider_order_id']).toBeUndefined();
    expect(opsLine(row(), NOW, true)).toMatchObject({
      seller_name: 'Quay',
      buyer_display_name: 'Vera',
      provider_order_id: 'PO1',
      capture_id: 'CAP1',
      refund_id: 'RF1',
    });
  });

  it('the buyer line has the seller name and the total but no buyer name', () => {
    const l = buyerLine(row(), NOW) as unknown as Record<string, unknown>;
    expect(l['seller_name']).toBe('Quay');
    expect(l['order_total_minor']).toBe(500);
    expect(l['buyer_display_name']).toBeUndefined();
  });
});

describe('csv', () => {
  const rows = [row()];
  const head = (s: string): string[] => s.split('\r\n')[0]!.split(',');
  const first = (s: string): string[] => s.split('\r\n')[1]!.split(',');

  it('buyer: order_ref header and full ref, no ops columns', () => {
    const lines = rows.map((r) => buyerLine(r, NOW));
    const csv = txnCsv('buyer', lines);
    expect(head(csv)[1]).toBe('order_ref');
    expect(head(csv)).toHaveLength(12);
    expect(first(csv)[1]).toBe('UM-AAAAAA123456');
  });

  it('seller: order_ref_last6 header and the last 6 only', () => {
    const csv = txnCsv(
      'seller',
      rows.map((r) => sellerLine(r, NOW)),
    );
    expect(head(csv)[1]).toBe('order_ref_last6');
    expect(head(csv)).toHaveLength(12);
    expect(first(csv)[1]).toBe('123456');
  });

  it('ops without identity: opaque ids and flags; with identity: names and provider ids too', () => {
    const plain = txnCsv(
      'ops',
      rows.map((r) => opsLine(r, NOW, false)),
      false,
    );
    expect(head(plain).slice(12)).toEqual([
      'unit_id',
      'buyer_id',
      'publisher_id',
      'alerts',
      'unknown_operation',
    ]);
    expect(first(plain).slice(12)).toEqual(['u1', 'buy1', 'pub1', '3', 'yes']);
    expect(head(plain)[1]).toBe('order_ref');
    expect(plain).not.toContain('Quay');
    const full = txnCsv(
      'ops',
      rows.map((r) => opsLine(r, NOW, true)),
      true,
    );
    expect(head(full).slice(17)).toEqual([
      'buyer_name',
      'seller_name',
      'provider_order_id',
      'capture_id',
      'refund_id',
    ]);
    expect(first(full).slice(17)).toEqual(['Vera', 'Quay', 'PO1', 'CAP1', 'RF1']);
  });

  it('ops: no unknown operation says no, and a missing alert count says 0', () => {
    const l = opsLine(row({ has_unknown_op: false }), NOW, false);
    const bare = { ...l, alert_count: undefined } as unknown as typeof l;
    expect(first(txnCsv('ops', [bare])).slice(15)).toEqual(['0', 'no']);
  });

  it('an ops-only column never appears on buyer and seller files, even with identity set', () => {
    const l = opsLine(row(), NOW, true);
    expect(head(txnCsv('buyer', [l], true))).toHaveLength(12);
    expect(head(txnCsv('seller', [l], true))).toHaveLength(12);
  });

  it('export names', () => {
    expect(exportName('ops', NOW)).toBe('operator-transactions-2026-11-05.csv');
    expect(exportName('seller', NOW)).toBe('sales-2026-11-05.csv');
    expect(exportName('buyer', NOW)).toBe('orders-2026-11-05.csv');
  });
});

describe('queryHash', () => {
  it('is 16 hex, stable, ignores key order and cursor, and changes with the query or principal', () => {
    const a = queryHash({ status: ['paid'], sort: 'amount' } as never, 'buyer:1');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(queryHash({ sort: 'amount', status: ['paid'], cursor: 'x' } as never, 'buyer:1')).toBe(
      a,
    );
    expect(queryHash({ status: ['paid'], sort: 'amount' } as never, 'buyer:2')).not.toBe(a);
    expect(queryHash({ status: ['failed'], sort: 'amount' } as never, 'buyer:1')).not.toBe(a);
    expect(queryHash({ a: 'a', b: 'b' } as never, 'p')).toBe(
      queryHash({ b: 'b', a: 'a' } as never, 'p'),
    );
    expect(queryHash({ a: 'b', b: 'a' } as never, 'p')).not.toBe(
      queryHash({ a: 'a', b: 'b' } as never, 'p'),
    );
    expect(queryHash({} as never, 'p')).toMatch(/^0*[0-9a-f]+$/);
  });
});
