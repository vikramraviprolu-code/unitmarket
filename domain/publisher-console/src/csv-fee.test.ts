// POB-M1: the statement file carries the money block of a block that has one, in the block's own currency (never converted),
// and a block without one (sold before the fee existed) gives exactly the file it gave before.
import { describe, expect, it } from 'vitest';
import { statementCsv } from './csv';
import type { PublisherStatement, StatementBlock } from './index';

const block = (over: Partial<StatementBlock> = {}): StatementBlock => ({
  currency: 'EUR',
  environment: 'sandbox',
  units_sold: 1,
  sales_minor: 500,
  refunds_minor: 100,
  reversals_minor: 0,
  net_minor: 400,
  paypal_fee_minor: null,
  money: null,
  settlement: { mode: 'direct', sentence: 'x' },
  lines: [
    { at: '2026-11-05T10:00:00.000Z', order_ref6: 'abc123', kind: 'sale', amount_minor: 500 },
  ],
  ...over,
});
const statement = (blocks: StatementBlock[]): PublisherStatement => ({
  environment: 'sandbox',
  settlement: { mode: 'direct', sentence: 'x' },
  commission: 'x',
  mismatch_units: 0,
  blocks,
});

describe('statementCsv money rows', () => {
  it('a block without a money block gives the rows it always gave', () => {
    const rows = statementCsv(statement([block()]))
      .trim()
      .split('\r\n');
    expect(rows.map((r) => r.split(',')[2])).toEqual([
      'kind',
      'sale',
      'total_sales',
      'total_refunds',
      'total_reversals',
      'total_net',
    ]);
  });
  it('a block with one adds five total rows in its own currency, after the old totals', () => {
    const csv = statementCsv(
      statement([
        block({
          money: {
            fee_minor: 40,
            owed_minor: 360,
            paid_out_minor: 300,
            adjustment_minor: 25,
            net_minor: 35,
          },
        }),
      ]),
    );
    const rows = csv.trim().split('\r\n');
    expect(rows.slice(-5)).toEqual([
      ',,total_fee_on_top,EUR,40,0.40,sandbox',
      ',,total_owed,EUR,360,3.60,sandbox',
      ',,total_paid_out,EUR,300,3.00,sandbox',
      ',,total_open_adjustments,EUR,25,0.25,sandbox',
      ',,total_next_payout,EUR,35,0.35,sandbox',
    ]);
    expect(rows.slice(-6)[0]).toContain('total_net');
    expect(csv).not.toMatch(/USD/);
  });
});
