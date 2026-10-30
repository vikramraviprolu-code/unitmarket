// PUB-C: the sales read model, S4. PGlite with synthetic rows of two publishers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { salesFor, UNIT_STATUS_TEXT } from './sales';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const P1 = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const P2 = { kind: 'publisher', publisher_id: 'pub_2' } as const;

beforeAll(async () => {
  w = await makeWorld();
  await w.unit({
    n: 1,
    publisher: 'pub_1',
    paypal_fee_minor: 29,
    title: 'Alpha',
    option: 'online_read',
  });
  await w.unit({ n: 2, publisher: 'pub_1', status: 'pending', captured: false });
  await w.unit({ n: 3, publisher: 'pub_1', status: 'declined', captured: false });
  await w.unit({ n: 4, publisher: 'pub_1', status: 'mismatch', captured: false });
  await w.unit({ n: 5, publisher: 'pub_1', status: 'reversal_suspected' });
  await w.unit({ n: 6, publisher: 'pub_1', status: 'partially_refunded' });
  await w.unit({ n: 7, publisher: 'pub_1', status: 'refunded' });
  await w.unit({ n: 8, publisher: 'pub_1', status: 'reversed' });
  await w.unit({ n: 9, publisher: 'pub_1', status: 'expected', captured: false });
  await w.unit({ n: 10, publisher: 'pub_2', title: 'Other publisher article', buyer: 'buy_2' });
});
afterAll(async () => {
  await w.close();
});

describe('salesFor', () => {
  it('lists one row per unit of the publisher, newest first, and none of the other publisher', async () => {
    const rows = await salesFor(w.db, P1);
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.items[0]?.title)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (n === 1 ? 'Alpha' : `Article ${String(n)}`)),
    );
    expect(JSON.stringify(rows)).not.toContain('Other publisher article');
    expect((await salesFor(w.db, P2)).map((r) => r.items[0]?.title)).toEqual([
      'Other publisher article',
    ]);
  });

  it('gives the words for each status, and "Not charged" only for declined (D-051)', async () => {
    const rows = await salesFor(w.db, P1);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.status_text]));
    expect(byStatus).toEqual({
      captured_verified: 'Paid',
      pending: 'Payment pending at PayPal',
      partially_refunded: 'Partly refunded',
      refunded: 'Refunded',
      reversal_suspected: 'On hold: payment being checked',
      reversed: 'Reversed',
      declined: 'Not charged',
      mismatch: 'On hold: under review',
      expected: 'Awaiting payment',
    });
    expect(UNIT_STATUS_TEXT.declined).toBe('Not charged');
    for (const r of rows) {
      if (r.status !== 'declined') expect(r.status_text).not.toMatch(/not charged/i);
    }
    // a held unit is never "Not charged"
    for (const s of ['mismatch', 'reversal_suspected', 'pending']) {
      expect(byStatus[s]).not.toMatch(/not charged/i);
    }
  });

  it('shows the PayPal fee only when one is stored, otherwise null (page says not reported)', async () => {
    const rows = await salesFor(w.db, P1);
    expect(rows.find((r) => r.items[0]?.title === 'Alpha')?.paypal_fee_minor).toBe(29);
    expect(rows.filter((r) => r.paypal_fee_minor !== null)).toHaveLength(1);
  });

  it('carries the amount, currency, order ref (last 6), access option, environment and date', async () => {
    const alpha = (await salesFor(w.db, P1)).find((r) => r.items[0]?.title === 'Alpha')!;
    expect(alpha).toMatchObject({
      amount_minor: 500,
      currency: 'USD',
      order_ref6: 'abc001',
      items: [{ title: 'Alpha', option: 'online_read' }],
      environment: 'dryrun',
      status: 'captured_verified',
      at: '2026-10-22T10:01:00.000Z',
    });
    // a unit that was never captured shows its creation time
    const declined = (await salesFor(w.db, P1)).find((r) => r.status === 'declined')!;
    expect(declined.at).toBe('2026-10-22T10:03:00.000Z');
  });

  it('never returns a buyer id, name or email (PRIV-1)', async () => {
    const text = JSON.stringify([...(await salesFor(w.db, P1)), ...(await salesFor(w.db, P2))]);
    for (const secret of ['buy_1', 'buy_2', 'Ann Buyer', 'Bob Buyer', 'sub_a', 'sub_b', '@']) {
      expect(text, secret).not.toContain(secret);
    }
    for (const r of await salesFor(w.db, P1)) {
      expect(Object.keys(r).sort()).toEqual(
        [
          'amount_minor',
          'at',
          'currency',
          'environment',
          'items',
          'order_ref6',
          'paypal_fee_minor',
          'status',
          'status_text',
        ].sort(),
      );
    }
  });

  it('gives an empty list for a publisher with no units', async () => {
    expect(await salesFor(w.db, { kind: 'publisher', publisher_id: 'pub_none' })).toEqual([]);
  });
});
