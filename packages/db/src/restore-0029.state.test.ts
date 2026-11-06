// POB-M1 review B2: a backup of a database that holds payouts in every state restores through the real importSql, with the
// INSERT guards on. Before the fix one payout that was not `due` (the dry run answers `confirmed`) made every later backup
// unrestorable, and so did a cancelled payout whose settlements had been released.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { exportSql, importSql, rowCounts } from './export-sql';
import { migrate, openDatabase } from './index';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const T = '2026-11-05T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const open: Db[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});
async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  open.push(d);
  await migrate(d, clock);
  return d;
}
async function ins(d: Pick<Database, 'query'>, table: string, row: Record<string, unknown>) {
  const r = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await d.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => (r as Record<string, unknown>)[c]),
  );
}
let n = 0;
async function unit(d: Db, publisher = 'pub_b'): Promise<string> {
  n += 1;
  await ins(d, 'approvals', {
    id: `apr_b${n}`,
    buyer_id: 'buy_b',
    snapshot: '{}',
    content_hash: 'a'.repeat(64),
    nonce: `nonce_b${n}`,
    expires_at: '2026-11-05T10:15:00.000Z',
    used_at: null,
    environment: 'dryrun',
  });
  await ins(d, 'orders', {
    id: `ord_b${n}`,
    approval_id: `apr_b${n}`,
    buyer_id: 'buy_b',
    content_hash: 'a'.repeat(60) + String(n).padStart(4, '0'),
    order_ref: `ref_b${n}`,
    expected: '{}',
    status: 'paid',
    mismatch: false,
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: 400,
    environment: 'dryrun',
  });
  await ins(d, 'order_units', {
    id: `unt_b${n}`,
    order_id: `ord_b${n}`,
    provider_order_ref: null,
    publisher_id: publisher,
    reference_id: `refid_b${n}`,
    payee_merchant_id: 'MERCHB',
    amount_minor: 400,
    platform_fee_minor: 0,
    capture_id: `CAPB${n}`,
    status: 'captured_verified',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 0,
    captured_verified_at: T,
    mismatch_reason: null,
  });
  await ins(d, 'ledger_entries', {
    id: `led_b${n}`,
    unit_id: `unt_b${n}`,
    capture_id: `CAPB${n}`,
    kind: 'sale',
    amount_minor: 400,
    currency: 'USD',
    refund_id: null,
    ref_entry_id: null,
    environment: 'dryrun',
  });
  return `unt_b${n}`;
}
async function payout(
  d: Db,
  id: string,
  unit_id: string,
  path: ('sending' | 'sent' | 'confirmed' | 'failed' | 'cancelled')[],
  o: { settle?: number; netted?: boolean } = {},
) {
  const settle = o.settle ?? 0;
  await d.transaction(async (tx) => {
    await ins(tx, 'payouts', {
      id,
      publisher_id: 'pub_b',
      currency: 'USD',
      amount_minor: 400 - settle,
      state: 'due',
      environment: 'dryrun',
      idempotency_key: `umsP-${id}`,
      payee_merchant_id: 'MERCHB',
    });
    await ins(tx, 'payout_items', {
      payout_id: id,
      order_unit_id: unit_id,
      seller_minor: 400,
      live: true,
    });
    if (settle > 0)
      await ins(tx, 'adjustment_settlements', {
        payout_id: id,
        adjustment_entry_id: `led_${id}`,
        amount_minor: settle,
        live: true,
      });
  });
  for (const state of path) {
    const extra =
      state === 'sending'
        ? `, sending_at = '${T}'`
        : state === 'sent' || state === 'confirmed'
          ? `, provider_ref = 'DRYRUN-umsP-${id}'`
          : state === 'failed'
            ? `, failure_reason = 'x', failed_at = '${T}'`
            : '';
    await d.query(`UPDATE payouts SET state = $2${extra}, updated_at = '${T}' WHERE id = $1`, [
      id,
      state,
    ]);
  }
  if (path.at(-1) === 'cancelled') {
    await d.query(
      `UPDATE payout_items SET live = false, updated_at = '${T}' WHERE payout_id = $1`,
      [id],
    );
    await d.query(
      `UPDATE adjustment_settlements SET live = false, updated_at = '${T}' WHERE payout_id = $1`,
      [id],
    );
  }
}

describe('export then import with payouts in every state', () => {
  it('round trips a sent, a confirmed, a failed and a cancelled payout, released settlements and the adjustment sources', async () => {
    const src = await fresh();
    await ins(src, 'publishers', {
      id: 'pub_b',
      slug: 'pb',
      display_name: 'Pub B',
      country: 'US',
      paypal_merchant_id: 'MERCHB',
      payee_verified_at: T,
    });
    await ins(src, 'buyers', {
      id: 'buy_b',
      display_name: 'B',
      auth_subject: 'sub_b',
      country: 'US',
    });
    await payout(src, 'pay_b_sent', await unit(src), ['sending', 'sent']);
    await payout(src, 'pay_b_conf', await unit(src), ['sending', 'confirmed']);
    await payout(src, 'pay_b_fail', await unit(src), ['sending', 'failed']);
    await payout(src, 'pay_b_canc', await unit(src), ['cancelled'], { settle: 100 }); // settlement released
    await payout(src, 'pay_b_both', await unit(src), ['sending', 'failed', 'cancelled'], {
      settle: 50,
    });
    await payout(src, 'pay_b_due', await unit(src), []);
    await ins(src, 'payout_adjustment_sources', {
      adjustment_entry_id: 'led_adj1',
      payout_id: 'pay_b_sent',
    });
    await ins(src, 'payout_adjustment_sources', {
      adjustment_entry_id: 'led_adj2',
      payout_id: 'pay_b_both',
    });

    const sql = await exportSql(src, { utc: T });
    const dst = await fresh();
    const counts = await importSql(dst, sql);
    expect(counts['payouts']).toBe(6);
    expect(counts['payout_items']).toBe(6);
    expect(counts['adjustment_settlements']).toBe(2);
    expect(counts['payout_adjustment_sources']).toBe(2);
    expect(await rowCounts(dst)).toEqual(await rowCounts(src));
    const states = async (d: Db) =>
      (
        await d.query(
          'SELECT id, state, amount_minor, provider_ref, failure_reason FROM payouts ORDER BY id',
        )
      ).rows;
    expect(await states(dst)).toEqual(await states(src));
    const live = async (d: Db) =>
      (
        await d.query(
          `SELECT (SELECT count(*) FROM payout_items WHERE live)::int AS items, (SELECT count(*) FROM adjustment_settlements WHERE live)::int AS settlements`,
        )
      ).rows;
    expect(await live(dst)).toEqual(await live(src));
    // the guards are back on after the load
    await expect(
      dst.query("UPDATE payouts SET state = 'due' WHERE id = 'pay_b_sent'"),
    ).rejects.toThrow();
    await expect(
      ins(dst, 'payouts', {
        id: 'pay_b_late',
        publisher_id: 'pub_b',
        currency: 'USD',
        amount_minor: 1,
        state: 'sent',
        environment: 'dryrun',
        idempotency_key: 'umsP-pay_b_late',
        payee_merchant_id: 'MERCHB',
        provider_ref: 'R',
        sending_at: T,
      }),
    ).rejects.toThrow();
  });
});
