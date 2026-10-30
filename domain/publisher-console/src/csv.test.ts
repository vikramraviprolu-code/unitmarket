// PUB-E1: the CSV writer is pure. Cells are made safe for spreadsheets, amounts are minor unit integers
// plus a decimal text, the order ref is the last 6 characters and no buyer appears.
import { describe, expect, it } from 'vitest';
import {
  CSV_ROW_CAP,
  csvCell,
  csvLine,
  decimalText,
  salesCsv,
  salesExport,
  statementCsv,
  statementExport,
} from './csv';
import type { SaleRow } from './sales';
import type { PublisherStatement } from './statement';

const sale = (over: Partial<SaleRow> = {}): SaleRow => ({
  at: '2026-10-22T10:01:00.000Z',
  order_ref6: 'abc001',
  items: [{ title: 'Tide tables', option: 'keep_retrieve' }],
  amount_minor: 250,
  currency: 'USD',
  paypal_fee_minor: 29,
  status: 'captured_verified',
  status_text: 'Paid',
  environment: 'sandbox',
  ...over,
});

describe('csvCell', () => {
  it('prefixes a single quote when a cell starts with = + - @ tab or CR', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${lead}SUM(A1)`).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });
  it('leaves a safe cell alone and quotes cells with a comma, quote or line break', () => {
    expect(csvCell('Tide tables')).toBe('Tide tables');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });
  it('writes null as empty and an integer as digits', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(250)).toBe('250');
  });
  it('quotes after the prefix when the unsafe cell also needs quoting', () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
  });
});

describe('decimalText', () => {
  it('formats minor units with two decimals, and zero decimals for JPY', () => {
    expect(decimalText(250, 'USD')).toBe('2.50');
    expect(decimalText(5, 'USD')).toBe('0.05');
    expect(decimalText(1234567, 'EUR')).toBe('12345.67');
    expect(decimalText(500, 'JPY')).toBe('500');
  });
});

describe('csvLine', () => {
  it('joins with commas and ends with CRLF', () => {
    expect(csvLine(['a', 'b,c', null, 3])).toBe('a,"b,c",,3\r\n');
  });
});

describe('salesCsv', () => {
  it('has a header, one row per counted unit, minor and decimal amounts, last 6 of the ref', () => {
    const text = salesCsv([
      sale(),
      sale({ order_ref6: 'abc002', paypal_fee_minor: null, amount_minor: 40 }),
    ]);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe(
      'date,order_ref_last6,article,access,currency,amount_minor,amount,paypal_fee_minor,paypal_fee,status,environment',
    );
    expect(lines[1]).toBe(
      '2026-10-22T10:01:00.000Z,abc001,Tide tables,keep_retrieve,USD,250,2.50,29,0.29,Paid,sandbox',
    );
    expect(lines[2]).toBe(
      '2026-10-22T10:01:00.000Z,abc002,Tide tables,keep_retrieve,USD,40,0.40,,,Paid,sandbox',
    );
    expect(lines[3]).toBe('');
  });
  it('leaves out units that are not paid (awaiting, pending, declined)', () => {
    const text = salesCsv([
      sale({ status: 'expected', status_text: 'Awaiting payment' }),
      sale({ status: 'pending', status_text: 'Payment pending at PayPal' }),
      sale({ status: 'declined', status_text: 'Not charged' }),
      sale({ status: 'refunded', status_text: 'Refunded' }),
    ]);
    expect(text.split('\r\n')).toHaveLength(3);
    expect(text).toContain('Refunded');
    expect(text).not.toContain('Not charged');
  });
  it('makes a hostile article title safe', () => {
    const text = salesCsv([sale({ items: [{ title: '=cmd|calc', option: 'online_read' }] })]);
    expect(text).toContain(",'=cmd|calc,");
    expect(text).not.toContain(',=cmd');
  });
  it('writes several currencies into one file with a currency column', () => {
    const text = salesCsv([sale(), sale({ currency: 'EUR' })]);
    expect(text).toContain(',USD,');
    expect(text).toContain(',EUR,');
  });
  it('has only the header for no sales', () => {
    expect(salesCsv([]).split('\r\n')).toHaveLength(2);
  });
});

const block = (env: 'dryrun' | 'sandbox'): PublisherStatement['blocks'][number] => ({
  currency: 'USD',
  environment: env,
  sales_minor: 500,
  refunds_minor: 100,
  reversals_minor: 0,
  net_minor: 400,
  paypal_fee_minor: 29,
  settlement: { mode: 'dryrun', sentence: 'x' } as never,
  lines: [
    { at: '2026-10-22T10:01:00.000Z', order_ref6: 'abc001', kind: 'sale', amount_minor: 500 },
    { at: '2026-10-22T10:02:00.000Z', order_ref6: 'abc001', kind: 'refund', amount_minor: 100 },
    { at: '2026-10-22T10:01:00.000Z', order_ref6: 'abc001', kind: 'paypal_fee', amount_minor: 29 },
  ],
});
const statement = (blocks: PublisherStatement['blocks']): PublisherStatement => ({
  environment: 'sandbox',
  settlement: { mode: 'dryrun', sentence: 'x' } as never,
  commission: 'c',
  blocks,
});

describe('statementCsv', () => {
  it('writes the lines and the totals per block', () => {
    const lines = statementCsv(statement([block('sandbox')])).split('\r\n');
    expect(lines[0]).toBe('date,order_ref_last6,kind,currency,amount_minor,amount,environment');
    expect(lines).toContain('2026-10-22T10:01:00.000Z,abc001,sale,USD,500,5.00,sandbox');
    expect(lines).toContain('2026-10-22T10:02:00.000Z,abc001,refund,USD,100,1.00,sandbox');
    expect(lines).toContain('2026-10-22T10:01:00.000Z,abc001,paypal_fee,USD,29,0.29,sandbox');
    expect(lines).toContain(',,total_sales,USD,500,5.00,sandbox');
    expect(lines).toContain(',,total_refunds,USD,100,1.00,sandbox');
    expect(lines).toContain(',,total_reversals,USD,0,0.00,sandbox');
    expect(lines).toContain(',,total_net,USD,400,4.00,sandbox');
    expect(lines).toContain(',,total_paypal_fee,USD,29,0.29,sandbox');
  });
  it('leaves PayPal fee lines out of a dry run block, as the page does', () => {
    const text = statementCsv(statement([block('dryrun')]));
    expect(text).not.toContain('paypal_fee,USD');
    expect(text).not.toContain('total_paypal_fee');
  });
  it('has only the header for no blocks', () => {
    expect(statementCsv(statement([])).split('\r\n')).toHaveLength(2);
  });
});

describe('row cap', () => {
  it('salesExport keeps at most the cap and says so', () => {
    const many = Array.from({ length: CSV_ROW_CAP + 3 }, (_, i) => sale({ order_ref6: String(i) }));
    const r = salesExport(many);
    expect(r.truncated).toBe(true);
    expect(r.csv.split('\r\n')).toHaveLength(CSV_ROW_CAP + 2);
    const small = salesExport([sale(), sale({ status: 'declined', status_text: 'Not charged' })]);
    expect(small.truncated).toBe(false);
    expect(small.csv).toBe(salesCsv([sale()]));
  });
  it('statementExport cuts the lines, keeps the totals, and says so', () => {
    const b = block('sandbox');
    b.lines = Array.from({ length: CSV_ROW_CAP + 2 }, (_, i) => ({
      at: '2026-10-22T10:01:00.000Z',
      order_ref6: String(i),
      kind: 'sale' as const,
      amount_minor: 1,
    }));
    const r = statementExport(statement([b]));
    expect(r.truncated).toBe(true);
    expect(r.csv).toContain(',,total_sales,USD,500,5.00,sandbox');
    expect(r.csv.split('\r\n').filter((l) => l.includes(',sale,USD,1,'))).toHaveLength(CSV_ROW_CAP);
    expect(statementExport(statement([block('sandbox')])).truncated).toBe(false);
  });
});
