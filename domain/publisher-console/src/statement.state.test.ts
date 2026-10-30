// PUB-C: the statement read model, S5. PGlite with synthetic ledger rows of two publishers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publisherBalances } from '@umsbx/ledger';
import type { LedgerEntry } from '@umsbx/contracts';
import { COMMISSION_LINE } from './settlement';
import { statementFor } from './statement';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const P1 = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const P2 = { kind: 'publisher', publisher_id: 'pub_2' } as const;
const CTX = { own_merchant_id: 'OWNERMERCH001', environment: 'dryrun' } as const;

beforeAll(async () => {
  w = await makeWorld();
  // pub_1, USD, dryrun: a sale with a fee, a partly refunded sale, a reversed sale, a held sale.
  const a = await w.unit({ n: 1, publisher: 'pub_1', amount_minor: 500, paypal_fee_minor: 29 });
  await w.ledger(a.unit_id, a.capture_id!, 'sale', 500);
  await w.ledger(a.unit_id, a.capture_id!, 'paypal_fee', 29);
  const b = await w.unit({
    n: 2,
    publisher: 'pub_1',
    amount_minor: 400,
    status: 'partially_refunded',
  });
  await w.ledger(b.unit_id, b.capture_id!, 'sale', 400);
  await w.ledger(b.unit_id, b.capture_id!, 'refund', 100, { refund_id: 'rf_a' });
  const c = await w.unit({ n: 3, publisher: 'pub_1', amount_minor: 300, status: 'reversed' });
  await w.ledger(c.unit_id, c.capture_id!, 'sale', 300);
  await w.ledger(c.unit_id, c.capture_id!, 'reversal', 300);
  const held = await w.unit({
    n: 4,
    publisher: 'pub_1',
    amount_minor: 250,
    status: 'reversal_suspected',
  });
  await w.ledger(held.unit_id, held.capture_id!, 'sale', 250);
  // a declined unit has no ledger row at all
  await w.unit({ n: 5, publisher: 'pub_1', status: 'declined', captured: false });
  // pub_1, EUR
  const e = await w.unit({ n: 6, publisher: 'pub_1', amount_minor: 200, currency: 'EUR' });
  await w.ledger(e.unit_id, e.capture_id!, 'sale', 200);
  // pub_1, USD, sandbox: its own block, never summed with the dry run rows
  const s = await w.unit({ n: 7, publisher: 'pub_1', amount_minor: 100, environment: 'sandbox' });
  await w.ledger(s.unit_id, s.capture_id!, 'sale', 100);
  // pub_2
  const o = await w.unit({ n: 8, publisher: 'pub_2', amount_minor: 999, buyer: 'buy_2' });
  await w.ledger(o.unit_id, o.capture_id!, 'sale', 999);
});
afterAll(async () => {
  await w.close();
});

describe('statementFor', () => {
  it('has one block per currency and environment, with the sums of the ledger rows', async () => {
    const st = await statementFor(w.db, P1, CTX);
    expect(st.blocks.map((b) => [b.currency, b.environment])).toEqual([
      ['EUR', 'dryrun'],
      ['USD', 'dryrun'],
      ['USD', 'sandbox'],
    ]);
    const usd = st.blocks[1]!;
    expect(usd).toMatchObject({
      sales_minor: 500 + 400 + 300 + 250,
      refunds_minor: 100,
      reversals_minor: 300,
      net_minor: 500 + 400 + 300 + 250 - 100 - 300,
      paypal_fee_minor: 29,
    });
    expect(st.blocks[0]).toMatchObject({
      sales_minor: 200,
      net_minor: 200,
      paypal_fee_minor: null,
    });
    expect(st.blocks[2]).toMatchObject({ sales_minor: 100, net_minor: 100 });
  });

  it('reports a fee as null (not reported) where no fee row is stored, never as 0', async () => {
    const st = await statementFor(w.db, P1, CTX);
    expect(st.blocks[0]!.paypal_fee_minor).toBeNull();
    expect(st.blocks[2]!.paypal_fee_minor).toBeNull();
  });

  it('reconciles: the net equals publisherBalances over the same rows', async () => {
    const st = await statementFor(w.db, P1, CTX);
    const raw = await w.db.query<{
      kind: string;
      amount_minor: number | string;
      currency: string;
      unit_id: string;
      capture_id: string;
      environment: string;
    }>(
      `SELECT l.kind, l.amount_minor, l.currency, l.unit_id, l.capture_id, l.environment
         FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.publisher_id = 'pub_1'`,
    );
    const bal = publisherBalances(
      raw.rows.map((r) => ({
        publisher_id: 'pub_1',
        entry: {
          id: 'x',
          unit_id: r.unit_id,
          capture_id: r.capture_id,
          kind: r.kind,
          amount: { currency: r.currency, minor: Number(r.amount_minor) },
          refund_id: null,
          ref_entry_id: null,
          created_at: '2026-10-22T10:00:00.000Z',
          environment: r.environment,
        } as LedgerEntry,
      })),
    );
    for (const cur of ['USD', 'EUR']) {
      const net = st.blocks.filter((b) => b.currency === cur).reduce((n, b) => n + b.net_minor, 0);
      expect(net).toBe(bal.find((b) => b.currency === cur)!.net_minor);
    }
  });

  it('lists a line per ledger row with its order ref, and fee lines are lines but not part of the net', async () => {
    const usd = (await statementFor(w.db, P1, CTX)).blocks[1]!;
    expect(usd.lines.map((l) => [l.kind, l.amount_minor, l.order_ref6])).toEqual([
      ['sale', 500, 'abc001'],
      ['paypal_fee', 29, 'abc001'],
      ['sale', 400, 'abc002'],
      ['refund', 100, 'abc002'],
      ['sale', 300, 'abc003'],
      ['reversal', 300, 'abc003'],
      ['sale', 250, 'abc004'],
    ]);
  });

  it('includes a held unit in the sums and never calls it "not charged"', async () => {
    const st = await statementFor(w.db, P1, CTX);
    expect(st.blocks[1]!.lines.some((l) => l.order_ref6 === 'abc004' && l.kind === 'sale')).toBe(
      true,
    );
    expect(JSON.stringify(st)).not.toMatch(/not charged/i);
  });

  it('does not include another publisher, and the other publisher sees only its own', async () => {
    const st1 = await statementFor(w.db, P1, CTX);
    expect(JSON.stringify(st1)).not.toContain('abc008');
    const st2 = await statementFor(w.db, P2, CTX);
    expect(st2.blocks).toHaveLength(1);
    expect(st2.blocks[0]).toMatchObject({ currency: 'USD', sales_minor: 999, net_minor: 999 });
  });

  it('derives the settlement sentence from the stored payee and the stored environment of the rows', async () => {
    const st = await statementFor(w.db, P1, { own_merchant_id: null, environment: 'sandbox' });
    expect(st.blocks[0]!.settlement.mode).toBe('dryrun'); // dryrun rows, whatever the app says
    expect(st.blocks[2]!.settlement.mode).toBe('direct'); // sandbox rows, own account
    await w.db.query(`UPDATE publishers SET payee_shared = true WHERE id = 'pub_1'`);
    const shared = await statementFor(w.db, P1, { own_merchant_id: null, environment: 'sandbox' });
    expect(shared.blocks[2]!.settlement.mode).toBe('owner_account');
    expect(shared.blocks[0]!.settlement.mode).toBe('dryrun');
    await w.db.query(`UPDATE publishers SET payee_shared = false WHERE id = 'pub_1'`);
  });

  it('with no ledger rows: no blocks, the app environment, the settlement for it, the commission line', async () => {
    const st = await statementFor(w.db, { kind: 'publisher', publisher_id: 'pub_none' }, CTX);
    expect(st.blocks).toEqual([]);
    expect(st.environment).toBe('dryrun');
    expect(st.settlement.mode).toBe('dryrun');
    expect(st.commission).toBe(COMMISSION_LINE);
  });

  it('never returns a buyer id, name or email (PRIV-1)', async () => {
    const text = JSON.stringify([
      await statementFor(w.db, P1, CTX),
      await statementFor(w.db, P2, CTX),
    ]);
    for (const secret of ['buy_1', 'buy_2', 'Ann Buyer', 'Bob Buyer', 'sub_a', 'sub_b', '@']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
