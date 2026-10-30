// The CSV files of a publisher (PUB-E1): pure text builders for the sales and the statement. The input is
// the read models' own output, so the publisher scope is already settled; nothing here reads a table.
// Safety: a cell that starts with = + - @ tab or CR gets a single quote in front (spreadsheet formula
// injection); a cell with a comma, quote or line break is quoted. No buyer appears in any row.
import type { SaleRow } from './sales';
import type { PublisherStatement } from './statement';

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell as CSV text. Null is empty; a number is its digits. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = typeof value === 'number' ? String(value) : value;
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row, ended by CRLF. */
export const csvLine = (cells: readonly (string | number | null)[]): string =>
  `${cells.map(csvCell).join(',')}\r\n`;

/** Minor units as a plain decimal: 250 gives 2.50 (two decimals; JPY has none). */
export function decimalText(minor: number, currency: string): string {
  if (currency === 'JPY') return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${String(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

// Same rule as the sales page: awaiting payment, pending at PayPal and declined units are not sales.
const NOT_A_SALE: readonly string[] = ['expected', 'pending', 'declined'];

const SALES_HEADER = [
  'date',
  'order_ref_last6',
  'article',
  'access',
  'currency',
  'amount_minor',
  'amount',
  'paypal_fee_minor',
  'paypal_fee',
  'status',
  'environment',
] as const;

export function salesCsv(rows: readonly SaleRow[]): string {
  let out = csvLine(SALES_HEADER);
  for (const r of rows) {
    if (NOT_A_SALE.includes(r.status)) continue;
    out += csvLine([
      r.at,
      r.order_ref6,
      r.items.map((i) => i.title).join('; '),
      r.items.map((i) => i.option).join('; '),
      r.currency,
      r.amount_minor,
      decimalText(r.amount_minor, r.currency),
      r.paypal_fee_minor,
      r.paypal_fee_minor === null ? null : decimalText(r.paypal_fee_minor, r.currency),
      r.status_text,
      r.environment,
    ]);
  }
  return out;
}

const STATEMENT_HEADER = [
  'date',
  'order_ref_last6',
  'kind',
  'currency',
  'amount_minor',
  'amount',
  'environment',
] as const;

export function statementCsv(statement: PublisherStatement): string {
  let out = csvLine(STATEMENT_HEADER);
  for (const b of statement.blocks) {
    const row = (at: string | null, ref: string | null, kind: string, minor: number): string =>
      csvLine([at, ref, kind, b.currency, minor, decimalText(minor, b.currency), b.environment]);
    for (const l of b.lines) {
      // A dry run moved no money, so it has no PayPal fee line (the page leaves it out too).
      if (b.environment === 'dryrun' && l.kind === 'paypal_fee') continue;
      out += row(l.at, l.order_ref6, l.kind, l.amount_minor);
    }
    out += row(null, null, 'total_sales', b.sales_minor);
    out += row(null, null, 'total_refunds', b.refunds_minor);
    out += row(null, null, 'total_reversals', b.reversals_minor);
    out += row(null, null, 'total_net', b.net_minor);
    if (b.paypal_fee_minor !== null && b.environment !== 'dryrun')
      out += row(null, null, 'total_paypal_fee', b.paypal_fee_minor);
  }
  return out;
}
