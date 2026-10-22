// State tests for receipts against a real (PGlite) database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@umsbx/approval';
import type { Result } from '@umsbx/contracts';
import {
  getReceiptForBuyer,
  issueReceiptIfChanged,
  receiptLabel,
  renderReceiptHtml,
} from './index';
import { DEBUG_ID, makeWorld } from './world';
import type { World } from './world';

let w: World;
let sb: World;
let n = 0;
beforeAll(async () => {
  w = await makeWorld('rct', 'dryrun');
  sb = await makeWorld('rct-sb', 'sandbox');
});
afterAll(async () => {
  await w.close();
  await sb.close();
});

const issue = (world: World, order_id: string) =>
  world.db.transaction((tx) => issueReceiptIfChanged(tx, world.deps, { order_id }));
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
const rawRow = async (world: World, order_id: string, version: number) =>
  (
    await world.db.query<{ body: unknown; sha256: string; environment: string }>(
      'SELECT body, sha256, environment FROM receipts WHERE order_id = $1 AND version = $2',
      [order_id, version],
    )
  ).rows[0]!;
const count = async (world: World, order_id: string) =>
  Number((await world.db.query<{ c: string }>('SELECT count(*) AS c FROM receipts WHERE order_id = $1', [order_id])).rows[0]!.c);

describe('issueReceiptIfChanged', () => {
  it('no receipt before a verified capture', async () => {
    n += 1;
    const o = await w.order(n, { captured: false });
    const r = await issue(w, o.order_id);
    expect(r).toEqual({ ok: false, error: { code: 'no_verified_capture' } });
    expect(await count(w, o.order_id)).toBe(0);
    const unknown = await issue(w, 'ord_nope');
    expect(unknown).toEqual({ ok: false, error: { code: 'unknown_order' } });
  });

  it('version 1 at verified capture, carrying snapshot, capture id, window and delivery evidence', async () => {
    n += 1;
    const o = await w.order(n);
    await w.event(o.entitlements[0]!, 'access_ready', '2026-10-22T10:00:01.000Z', 1);
    const v1 = value(await issue(w, o.order_id));
    expect(v1).toMatchObject({ version: 1, changed: true });
    expect(v1.receipt_id).toMatch(/^rct_/);
    const r = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    expect(r.version).toBe(1);
    expect(r.snapshot).toEqual(o.snapshot);
    expect(r.environment).toBe('dryrun');
    expect(r.lines.map((l) => l.article_id)).toEqual(o.articles);
    expect(r.lines[0]).toMatchObject({
      option: 'keep_retrieve', amount_minor: 400, capture_id: o.capture_id,
      window: { state: 'running', credit_ms: 0, ends_at: '2026-10-27T10:00:00.000Z' },
      delivery: [{ kind: 'access_ready', at: '2026-10-22T10:00:01.000Z' }],
    });
    expect(r.lines[1]!.delivery).toEqual([]);
    expect(r.refunds).toEqual([]);
    expect(r.debug_ids).toEqual([DEBUG_ID.slice(-6)]);
    expect(JSON.stringify(r)).not.toContain(DEBUG_ID);
  });

  it('a second issue with nothing changed adds no version', async () => {
    n += 1;
    const o = await w.order(n);
    const a = value(await issue(w, o.order_id));
    const b = value(await issue(w, o.order_id));
    expect(b).toEqual({ ...a, changed: false });
    expect(await count(w, o.order_id)).toBe(1);
  });

  it('refund makes receipt version 2, version 1 unchanged', async () => {
    n += 1;
    const o = await w.order(n);
    const v1 = value(await issue(w, o.order_id));
    const before = await rawRow(w, o.order_id, 1);
    w.clock.advance(60_000);
    value(await w.refund(o, 'RF1', 100));
    const v2 = value(await issue(w, o.order_id));
    expect(v2).toMatchObject({ version: 2, changed: true });
    expect(v2.sha256).not.toBe(v1.sha256);
    expect(v2.receipt_id).not.toBe(v1.receipt_id);
    const after = await rawRow(w, o.order_id, 1);
    expect(after).toEqual(before);
    const r2 = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    expect(r2.version).toBe(2);
    expect(r2.refunds).toEqual([{ refund_id: 'RF1', amount: { currency: 'USD', minor: 100 }, at: expect.any(String) }]);
    const r1 = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A', version: 1 }))!;
    expect(r1.version).toBe(1);
    expect(r1.refunds).toEqual([]);
    expect(r1.sha256).toBe(v1.sha256);
    // A second partial refund is a third version.
    value(await w.refund(o, 'RF2', 50));
    expect(value(await issue(w, o.order_id))).toMatchObject({ version: 3, changed: true });
  });

  it('a delivery milestone makes a new version', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(w, o.order_id));
    await w.event(o.entitlements[1]!, 'reader_rendered', '2026-10-22T10:30:00.000Z', 2);
    const v2 = value(await issue(w, o.order_id));
    expect(v2).toMatchObject({ version: 2, changed: true });
    const r = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    expect(r.lines[1]!.delivery).toEqual([{ kind: 'reader_rendered', at: '2026-10-22T10:30:00.000Z' }]);
  });

  it('a reversal shows on the receipt and makes a new version', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(w, o.order_id));
    value(
      await w.db.transaction((tx) =>
        import('@umsbx/ledger').then((m) =>
          m.appendLedgerEntry(tx, w.deps, {
            unit_id: o.unit_id, capture_id: o.capture_id, kind: 'reversal',
            amount: { currency: 'USD', minor: 650 }, refund_id: null, ref_entry_id: null,
          }),
        ),
      ),
    );
    expect(value(await issue(w, o.order_id))).toMatchObject({ version: 2, changed: true });
    const r = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    expect(r.refunds.map((x) => x.refund_id)).toEqual([`reversal:${o.capture_id}`]);
  });

  it('issuing twice at once leaves one row per version', async () => {
    n += 1;
    const o = await w.order(n);
    const rs = await Promise.all([issue(w, o.order_id), issue(w, o.order_id)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(await count(w, o.order_id)).toBe(1);
  });
});

describe('hash (PAY-09)', () => {
  it('sha256 shown equals stored', async () => {
    n += 1;
    const o = await w.order(n);
    const v = value(await issue(w, o.order_id));
    const row = await rawRow(w, o.order_id, 1);
    // stored hash is the hash of the stored body, recomputed here from the database bytes
    expect(row.sha256).toBe(sha256Hex(canonicalJson(row.body, 2)));
    const r = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
    const html = renderReceiptHtml(r, receiptLabel(r.environment));
    expect(r.sha256).toBe(row.sha256);
    expect(v.sha256).toBe(row.sha256);
    expect(html).toContain(row.sha256);
  });

  it('a stored body that no longer matches its hash is not shown', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(w, o.order_id));
    // Simulate corruption below the application: bypass the immutability trigger as a superuser would.
    await w.db.exec(`ALTER TABLE receipts DISABLE TRIGGER receipts_immutable`);
    await w.db.query(`UPDATE receipts SET body = jsonb_set(body, '{order_id}', '"ord_other"') WHERE order_id = $1`, [o.order_id]);
    await w.db.exec(`ALTER TABLE receipts ENABLE TRIGGER receipts_immutable`);
    await expect(getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' })).rejects.toThrow(/hash/i);
  });
});

describe('immutability (P12, A-21)', () => {
  it('UPDATE and DELETE refused', async () => {
    n += 1;
    const o = await w.order(n);
    value(await issue(w, o.order_id));
    await expect(w.db.query(`UPDATE receipts SET sha256 = $2 WHERE order_id = $1`, [o.order_id, 'c'.repeat(64)])).rejects.toThrow(/append-only/);
    await expect(w.db.query(`DELETE FROM receipts WHERE order_id = $1`, [o.order_id])).rejects.toThrow(/append-only/);
    expect(await count(w, o.order_id)).toBe(1);
  });
});

describe('label from data (P16, A-22)', () => {
  it('label Dry run for dryrun and Sandbox for sandbox', async () => {
    n += 1;
    const d = await w.order(n);
    const s = await sb.order(n);
    value(await issue(w, d.order_id));
    value(await issue(sb, s.order_id));
    const rd = (await getReceiptForBuyer(w.db, { order_id: d.order_id, buyer_id: 'buy_A' }))!;
    const rs = (await getReceiptForBuyer(sb.db, { order_id: s.order_id, buyer_id: 'buy_A' }))!;
    expect(rd.environment).toBe('dryrun');
    expect(rs.environment).toBe('sandbox');
    const hd = renderReceiptHtml(rd, receiptLabel(rd.environment));
    const hs = renderReceiptHtml(rs, receiptLabel(rs.environment));
    expect(hd).toContain('Dry run');
    expect(hd).not.toContain('Sandbox');
    expect(hs).toContain('Sandbox');
    expect(hs).not.toContain('Dry run');
    expect((await rawRow(sb, s.order_id, 1)).environment).toBe('sandbox');
  });
});
