// Opus review 3: M3, L9, L10 for receipts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Receipt, Result } from '@umsbx/contracts';
import {
  getReceiptForBuyer,
  issueReceiptIfChanged,
  receiptBodyHash,
  receiptLabel,
  renderReceiptHtml,
} from './index';
import type { ReceiptBody } from './index';
import { DEBUG_ID, makeWorld } from './world';
import type { World } from './world';

let w: World;
let n = 100;
beforeAll(async () => {
  w = await makeWorld('rcr', 'dryrun');
});
afterAll(async () => {
  await w.close();
});
const issue = (order_id: string) =>
  w.db.transaction((tx) => issueReceiptIfChanged(tx, w.deps, { order_id }));
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
const call = (id: string, n: number, operation: string, debug_id: string) =>
  w.insert('provider_calls', {
    id,
    operation_id: `opr_${n}`,
    operation,
    method: 'GET',
    path_template: '/x',
    http_status: 200,
    outcome: 'ok',
    debug_id,
    duration_ms: 1,
    transport_kind: 'dryrun',
    request_redacted: '{}',
    response_redacted: '{}',
    environment: 'dryrun',
  });
const buyerEvent = (ent: string, kind: string, at: string, tag: string) =>
  w.insert('access_events', {
    id: `aev_${tag}`,
    entitlement_id: ent,
    link_id: null,
    kind,
    at,
    source: 'buyer',
    evidence: '{}',
    environment: 'dryrun',
  });

describe('M3 receipt versions do not churn', () => {
  it('debug ids come from capture and refund calls only', async () => {
    n += 1;
    const o = await w.order(n);
    await call(`pcl_read_${n}`, n, 'get_order', 'READBACKDEBUG1');
    await call(`pcl_getcap_${n}`, n, 'get_capture', 'GETCAPDEBUG22');
    await call(`pcl_ref_${n}`, n, 'refund_capture', 'REFUNDDEBUG333');
    value(await issue(o.order_id));
    const r = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    expect(r.debug_ids).toEqual([DEBUG_ID.slice(-6), 'BUG333']);
  });

  it('a later re-read (new get_order or get_capture call) creates no version', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(o.order_id));
    await call(`pcl_a_${n}`, n, 'get_order', 'NEWDEBUGID0001');
    await call(`pcl_b_${n}`, n, 'get_capture', 'NEWDEBUGID0002');
    expect(value(await issue(o.order_id))).toMatchObject({ version: 1, changed: false });
  });

  it('a reader beacon and a buyer-sourced event create no version', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(o.order_id));
    const ent = o.entitlements[0]!;
    await buyerEvent(ent, 'reader_beacon', '2026-10-22T10:20:00.000Z', `bc_${n}`);
    await buyerEvent(ent, 'reader_rendered', '2026-10-22T10:21:00.000Z', `br_${n}`);
    expect(value(await issue(o.order_id))).toMatchObject({ version: 1, changed: false });
    const r = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    expect(r.lines[0]!.delivery.map((e) => e.kind)).not.toContain('reader_beacon');
  });

  it('a link re-issue (link_issued) creates no version', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(o.order_id));
    await w.event(o.entitlements[0]!, 'link_issued', '2026-10-22T10:25:00.000Z', 9);
    expect(value(await issue(o.order_id))).toMatchObject({ version: 1, changed: false });
  });

  it('a system delivery milestone still makes a version', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(o.order_id));
    await w.event(o.entitlements[0]!, 'download_completed', '2026-10-22T10:30:00.000Z', 3);
    expect(value(await issue(o.order_id))).toMatchObject({ version: 2, changed: true });
  });
});

describe('L9 the label cannot contradict the environment', () => {
  const base = (environment: 'dryrun' | 'sandbox'): Receipt => ({
    receipt_id: 'rct_1',
    version: 1,
    sha256: 'a'.repeat(64),
    created_at: '2026-10-22T10:00:00.000Z',
    order_id: 'ord_1',
    snapshot: {
      snapshot_version: '1',
      items: [],
      publishers: [],
      total_minor: 0,
      currency: 'USD',
      corridor_id: 'us-usd',
      reader: { buyer_id: 'buy_A' },
      rule_version: 'r',
      pricing_rule_version: 'p',
    },
    content_hash: 'b'.repeat(64),
    lines: [],
    refunds: [],
    debug_ids: [],
    environment,
  });
  it('derives the label from the environment when none is given', () => {
    expect(renderReceiptHtml(base('sandbox'))).toContain('<strong>Sandbox</strong>');
    expect(renderReceiptHtml(base('dryrun'))).toContain('<strong>Dry run</strong>');
  });
  it('refuses a label that contradicts the environment', () => {
    expect(() => renderReceiptHtml(base('dryrun'), 'Sandbox')).toThrow(/label/);
    expect(() => renderReceiptHtml(base('sandbox'), 'Dry run')).toThrow(/label/);
    expect(() => renderReceiptHtml(base('sandbox'), receiptLabel('sandbox'))).not.toThrow();
  });
});

describe('L10 golden receipt hash', () => {
  it('a fixed body has a fixed hash', () => {
    const body: ReceiptBody = {
      order_id: 'ord_1',
      snapshot: {
        snapshot_version: '1',
        items: [],
        publishers: [],
        total_minor: 405,
        currency: 'USD',
        corridor_id: 'us-usd',
        reader: { buyer_id: 'buy_A' },
        rule_version: 'rules-1',
        pricing_rule_version: 'pricing-1',
      },
      content_hash: 'b'.repeat(64),
      lines: [],
      refunds: [
        { refund_id: 'RF1', amount: { currency: 'USD', minor: 5 }, at: '2026-10-22T11:00:00.000Z' },
      ],
      debug_ids: ['567890'],
      environment: 'dryrun',
    };
    expect(receiptBodyHash(body)).toBe(
      'cc997c446b5a97fe855bd2be12d60fce27427edfad3f83b5b7659d5da70b23a7',
    );
  });
});
