// POB-M1 (D-089): the publisher statement shows, per currency and environment, the sale, the UnitMarket fee on top, what is
// owed to the publisher, what was paid out, the open adjustments (refunded after payout) and the next payout.
// Every figure is a sum of stored rows. Synthetic rows only; PGlite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEE_ON_TOP_LINE, COMMISSION_LINE, salesTotals, statementFor } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const P1 = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const P2 = { kind: 'publisher', publisher_id: 'pub_2' } as const;
const CTX = { own_merchant_id: 'OWNERMERCH001', environment: 'dryrun' } as const;

beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.close();
});

let k = 100;
interface Sold {
  unit_id: string;
  capture_id: string;
  n: number;
}
/** A captured unit of seller + fee, with its parts row and its sale, fee and payable rows. */
async function sold(
  publisher: 'pub_1' | 'pub_2',
  seller: number,
  fee: number,
  over: { currency?: 'USD' | 'EUR'; environment?: 'dryrun' | 'sandbox' } = {},
): Promise<Sold> {
  k += 1;
  const u = await w.unit({
    n: k,
    publisher,
    amount_minor: seller + fee,
    ...(over.currency === undefined ? {} : { currency: over.currency }),
    ...(over.environment === undefined ? {} : { environment: over.environment }),
  });
  await w.insert('order_unit_parts', {
    unit_id: u.unit_id,
    seller_minor: seller,
    fee_minor: fee,
    tax_minor: 0,
  });
  await w.ledger(u.unit_id, u.capture_id!, 'sale', seller + fee);
  if (fee > 0) await w.ledger(u.unit_id, u.capture_id!, 'fee', fee);
  await w.ledger(u.unit_id, u.capture_id!, 'payable', seller);
  return { unit_id: u.unit_id, capture_id: u.capture_id!, n: k };
}
async function refunded(u: Sold, id: string, total: number, fee: number, payable: number) {
  await w.ledger(u.unit_id, u.capture_id, 'refund', total, { refund_id: id });
  if (fee > 0) await w.ledger(u.unit_id, u.capture_id, 'fee_reversal', fee, { refund_id: id });
  if (payable > 0)
    await w.ledger(u.unit_id, u.capture_id, 'payable_reversal', payable, { refund_id: id });
}
/** A payout with its items in one transaction (the database checks the sum when it commits). */
async function payout(
  id: string,
  publisher: string,
  items: { u: Sold; minor: number }[],
  state: 'due' | 'sent' | 'confirmed' | 'failed' | 'cancelled',
  o: { currency?: string; environment?: string; settled?: { entry: string; minor: number }[] } = {},
) {
  const settled = o.settled ?? [];
  const amount = items.reduce((s, i) => s + i.minor, 0) - settled.reduce((s, x) => s + x.minor, 0);
  await w.db.transaction(async (tx) => {
    const at = '2026-10-22T10:00:00.000Z';
    const q = (sql: string, p: unknown[]) => tx.query(sql, p);
    await q(
      `INSERT INTO payouts (id, publisher_id, currency, amount_minor, state, environment, idempotency_key, payee_merchant_id, provider_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'MERCHANT0001A', $8, $9, $9)`,
      [
        id,
        publisher,
        o.currency ?? 'USD',
        amount,
        amount === 0 ? 'confirmed' : 'due',
        o.environment ?? 'dryrun',
        `umsP-${id}`,
        amount === 0 ? `NETTED-${id}` : null,
        at,
      ],
    );
    for (const i of items) {
      await q(
        `INSERT INTO payout_items (payout_id, order_unit_id, seller_minor, live, created_at, updated_at) VALUES ($1, $2, $3, true, $4, $4)`,
        [id, i.u.unit_id, i.minor, at],
      );
    }
    for (const s of settled) {
      await q(
        `INSERT INTO adjustment_settlements (payout_id, adjustment_entry_id, amount_minor, live, created_at, updated_at) VALUES ($1, $2, $3, true, $4, $4)`,
        [id, s.entry, s.minor, at],
      );
    }
  });
  if (state === 'due' || amount === 0) return;
  const step = (to: string, extra = '') =>
    w.db.query(
      `UPDATE payouts SET state = $2${extra}, updated_at = '2026-10-22T10:00:00.000Z' WHERE id = $1`,
      [id, to],
    );
  if (state === 'cancelled') {
    await step('cancelled');
    await w.db.query(`UPDATE payout_items SET live = false WHERE payout_id = $1`, [id]);
    return;
  }
  await step('sending', ", sending_at = '2026-10-22T10:00:00.000Z'");
  if (state === 'failed')
    await step('failed', ", failure_reason = 'x', failed_at = '2026-10-22T10:00:00.000Z'");
  else await step(state, `, provider_ref = 'DRYRUN-umsP-${id}'`);
}
const money = async (actor = P1, currency = 'USD', environment: 'dryrun' | 'sandbox' = 'dryrun') =>
  (await statementFor(w.db, actor, CTX)).blocks.find(
    (b) => b.currency === currency && b.environment === environment,
  )!.money;

describe('the money block of the statement', () => {
  it('is null where no unit has parts (sold before the fee), and the old figures are as before', async () => {
    const u = await w.unit({ n: 1, publisher: 'pub_2', amount_minor: 300 });
    await w.ledger(u.unit_id, u.capture_id!, 'sale', 300);
    const st = await statementFor(w.db, P2, CTX);
    expect(st.blocks[0]!.money).toBeNull();
    expect(st.blocks[0]).toMatchObject({ sales_minor: 300, net_minor: 300 });
    expect(st.commission).toBe(COMMISSION_LINE);
  });

  it('a sale with a fee: sale, fee on top, owed to the publisher, nothing paid out yet', async () => {
    await sold('pub_1', 450, 50, { currency: 'EUR' });
    const st = await statementFor(w.db, P1, CTX);
    const b = st.blocks.find((x) => x.currency === 'EUR')!;
    expect(b.sales_minor).toBe(500);
    expect(b.money).toEqual({
      fee_minor: 50,
      owed_minor: 450,
      paid_out_minor: 0,
      adjustment_minor: 0,
      net_minor: 450,
    });
    // the ledger lines of the page are still sale, refund, reversal and PayPal fee only
    expect(b.lines.map((l) => l.kind)).toEqual(['sale']);
    expect(st.commission).toBe(FEE_ON_TOP_LINE);
  });

  it('a partial refund takes its share of the fee and of the payable', async () => {
    const u = await sold('pub_1', 450, 50, { currency: 'USD' });
    await refunded(u, 'rf_1', 100, 10, 90);
    expect(await money()).toEqual({
      fee_minor: 40,
      owed_minor: 360,
      paid_out_minor: 0,
      adjustment_minor: 0,
      net_minor: 360,
    });
  });

  it('a payout that is only due is not paid out; a sent or confirmed one is', async () => {
    const a = await sold('pub_1', 100, 10, { environment: 'sandbox' });
    const b = await sold('pub_1', 200, 20, { environment: 'sandbox' });
    const c = await sold('pub_1', 300, 30, { environment: 'sandbox' });
    await payout('pay_s1', 'pub_1', [{ u: a, minor: 100 }], 'due', { environment: 'sandbox' });
    expect(await money(P1, 'USD', 'sandbox')).toMatchObject({
      paid_out_minor: 0,
      owed_minor: 600,
      net_minor: 600,
    });
    await payout('pay_s2', 'pub_1', [{ u: b, minor: 200 }], 'sent', { environment: 'sandbox' });
    await payout('pay_s3', 'pub_1', [{ u: c, minor: 300 }], 'confirmed', {
      environment: 'sandbox',
    });
    // a is still in a due payout: it is queued, so it is the next payout; b and c are paid
    expect(await money(P1, 'USD', 'sandbox')).toEqual({
      fee_minor: 60,
      owed_minor: 600,
      paid_out_minor: 500,
      adjustment_minor: 0,
      net_minor: 100,
    });
  });

  it('a failed or cancelled payout pays nothing: its units are still waiting', async () => {
    const a = await sold('pub_1', 70, 7, { currency: 'EUR', environment: 'sandbox' });
    const b = await sold('pub_1', 80, 8, { currency: 'EUR', environment: 'sandbox' });
    await payout('pay_f1', 'pub_1', [{ u: a, minor: 70 }], 'failed', {
      currency: 'EUR',
      environment: 'sandbox',
    });
    await payout('pay_c1', 'pub_1', [{ u: b, minor: 80 }], 'cancelled', {
      currency: 'EUR',
      environment: 'sandbox',
    });
    expect(await money(P1, 'EUR', 'sandbox')).toEqual({
      fee_minor: 15,
      owed_minor: 150,
      paid_out_minor: 0,
      adjustment_minor: 0,
      net_minor: 150,
    });
  });

  it('A paid then refunded, B earned: owed 100, adjustment 100, next payout 0', async () => {
    // A: 100 for the publisher + 10 fee. Paid out, then refunded in full after the payout.
    const A = await sold('pub_2', 100, 10, { environment: 'sandbox', currency: 'USD' });
    await payout('pay_ab1', 'pub_2', [{ u: A, minor: 100 }], 'sent', { environment: 'sandbox' });
    await refunded(A, 'rf_ab', 110, 10, 100);
    await w.ledger(A.unit_id, A.capture_id, 'payout_adjustment', 100, { refund_id: 'rf_ab' });
    // B: earned, not yet paid
    await sold('pub_2', 100, 10, { environment: 'sandbox', currency: 'USD' });
    const m = await money(P2, 'USD', 'sandbox');
    expect(m).toEqual({
      fee_minor: 10,
      owed_minor: 100,
      paid_out_minor: 100,
      adjustment_minor: 100,
      net_minor: 0,
    });
  });

  it('a live settlement uses an adjustment up', async () => {
    const A = await sold('pub_2', 100, 10, { currency: 'EUR', environment: 'dryrun' });
    await payout('pay_st1', 'pub_2', [{ u: A, minor: 100 }], 'sent', { currency: 'EUR' });
    await refunded(A, 'rf_st', 110, 10, 100);
    await w.ledger(A.unit_id, A.capture_id, 'payout_adjustment', 100, { refund_id: 'rf_st' });
    const adj = (
      await w.db.query<{ id: string }>(
        `SELECT id FROM ledger_entries WHERE kind = 'payout_adjustment' AND refund_id = 'rf_st'`,
      )
    ).rows[0]!.id;
    const before = await money(P2, 'EUR', 'dryrun');
    expect(before).toMatchObject({ adjustment_minor: 100, net_minor: 0 });
    const B = await sold('pub_2', 100, 10, { currency: 'EUR', environment: 'dryrun' });
    expect((await money(P2, 'EUR', 'dryrun'))!.net_minor).toBe(0); // 100 earned, 100 owed back
    await payout('pay_st2', 'pub_2', [{ u: B, minor: 100 }], 'confirmed', {
      currency: 'EUR',
      settled: [{ entry: adj, minor: 100 }],
    });
    expect(await money(P2, 'EUR', 'dryrun')).toEqual({
      fee_minor: 10,
      owed_minor: 100,
      paid_out_minor: 100,
      adjustment_minor: 0,
      net_minor: 0,
    });
  });

  it('is only the signed-in publisher: another publisher sees none of these figures', async () => {
    const mine = await statementFor(w.db, P1, CTX);
    const theirs = await statementFor(w.db, P2, CTX);
    expect(JSON.stringify(theirs)).not.toContain('pub_1');
    expect(mine.blocks.length).toBeGreaterThan(0);
    const none = await statementFor(w.db, { kind: 'buyer', buyer_id: 'buy_1' }, CTX);
    expect(none.blocks).toEqual([]);
  });

  it('the sales page totals carry the same money block, by construction', async () => {
    const st = await statementFor(w.db, P1, CTX);
    const totals = salesTotals(st.blocks);
    expect(totals.map((t) => t.money)).toEqual(st.blocks.map((b) => b.money));
  });
});
