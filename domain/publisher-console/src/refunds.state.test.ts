// PUB-E1: the refunds read model. PGlite with synthetic rows of two publishers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refundsFor } from './refunds';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const P1 = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const P2 = { kind: 'publisher', publisher_id: 'pub_2' } as const;

beforeAll(async () => {
  w = await makeWorld();
  // 1: paid, never refunded (not in the view)
  const u1 = await w.unit({ n: 1, publisher: 'pub_1', title: 'Plain' });
  await w.ledger('unt_1', u1.capture_id!, 'sale', 500);
  // 2: partly refunded, two refund rows
  const u2 = await w.unit({
    n: 2,
    publisher: 'pub_1',
    status: 'partially_refunded',
    title: 'Partly',
  });
  await w.ledger('unt_2', u2.capture_id!, 'sale', 500, { at: '2026-10-22T11:00:00.000Z' });
  await w.ledger('unt_2', u2.capture_id!, 'refund', 100, {
    refund_id: 'rf_a',
    at: '2026-10-23T09:00:00.000Z',
  });
  await w.ledger('unt_2', u2.capture_id!, 'refund', 50, {
    refund_id: 'rf_b',
    at: '2026-10-24T09:00:00.000Z',
  });
  // 3: fully refunded
  const u3 = await w.unit({ n: 3, publisher: 'pub_1', status: 'refunded', title: 'Whole' });
  await w.ledger('unt_3', u3.capture_id!, 'sale', 500, { at: '2026-10-22T11:00:00.000Z' });
  await w.ledger('unt_3', u3.capture_id!, 'refund', 500, {
    refund_id: 'rf_c',
    at: '2026-10-25T09:00:00.000Z',
  });
  // 4: reversal suspected, no ledger row beyond the sale
  const u4 = await w.unit({
    n: 4,
    publisher: 'pub_1',
    status: 'reversal_suspected',
    title: 'Held',
  });
  await w.ledger('unt_4', u4.capture_id!, 'sale', 500, { at: '2026-10-22T11:00:00.000Z' });
  // 5: reversed with a reversal row
  const u5 = await w.unit({ n: 5, publisher: 'pub_1', status: 'reversed', title: 'Back' });
  await w.ledger('unt_5', u5.capture_id!, 'sale', 500, { at: '2026-10-22T11:00:00.000Z' });
  await w.ledger('unt_5', u5.capture_id!, 'reversal', 500, { at: '2026-10-26T09:00:00.000Z' });
  // 6: another publisher, refunded, with a buyer
  const u6 = await w.unit({
    n: 6,
    publisher: 'pub_2',
    status: 'refunded',
    title: 'Other',
    buyer: 'buy_2',
  });
  await w.ledger('unt_6', u6.capture_id!, 'sale', 500);
  await w.ledger('unt_6', u6.capture_id!, 'refund', 500, { refund_id: 'rf_z' });
});
afterAll(async () => {
  await w.close();
});

describe('refundsFor', () => {
  it('lists refunded, partly refunded, held and reversed units, newest first, and no plain sale', async () => {
    const rows = await refundsFor(w.db, P1);
    expect(rows.map((r) => r.items[0]?.title)).toEqual(['Back', 'Whole', 'Partly', 'Held']);
    expect(JSON.stringify(rows)).not.toContain('Plain');
  });
  it('sums refund and reversal rows from the ledger and keeps the original amount', async () => {
    const rows = await refundsFor(w.db, P1);
    const by = Object.fromEntries(rows.map((r) => [r.items[0]!.title, r]));
    expect(by['Partly']).toMatchObject({
      amount_minor: 500,
      refunded_minor: 150,
      reversed_minor: 0,
      status: 'partially_refunded',
      status_text: 'Partly refunded',
      at: '2026-10-24T09:00:00.000Z',
      currency: 'USD',
      environment: 'dryrun',
    });
    expect(by['Whole']).toMatchObject({ refunded_minor: 500, status_text: 'Refunded' });
    expect(by['Back']).toMatchObject({
      reversed_minor: 500,
      refunded_minor: 0,
      status_text: 'Reversed',
    });
  });
  it('shows a held unit with no refund row, dated by the unit, and never as Not charged', async () => {
    const held = (await refundsFor(w.db, P1)).find((r) => r.items[0]?.title === 'Held')!;
    expect(held).toMatchObject({
      refunded_minor: 0,
      reversed_minor: 0,
      status_text: 'On hold: payment being checked',
    });
    expect(held.at).toMatch(/^2026-10-22T/);
    expect(JSON.stringify(held)).not.toContain('Not charged');
  });
  it('gives the last 6 of the order ref and no buyer identity', async () => {
    const rows = await refundsFor(w.db, P1);
    expect(rows.every((r) => r.order_ref6.length === 6)).toBe(true);
    const text = JSON.stringify(rows);
    for (const secret of ['buy_1', 'buy_2', 'Ann Buyer', 'Bob Buyer', 'sub_a', 'ordref_abc']) {
      expect(text).not.toContain(secret);
    }
  });
  it('shows publisher 2 only its own unit', async () => {
    const rows = await refundsFor(w.db, P2);
    expect(rows.map((r) => r.items[0]?.title)).toEqual(['Other']);
  });
  it('answers an empty list for a non publisher actor', async () => {
    expect(await refundsFor(w.db, { kind: 'buyer', buyer_id: 'buy_1' } as never)).toEqual([]);
  });
});
