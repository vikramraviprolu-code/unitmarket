// The words the publisher sales page (S4) and statement page (S5) show (PUB-C). Pure: no server module,
// no clock. The money words themselves (status words, the settlement sentence, the commission line)
// live in @umsbx/publisher-console next to the code that decides them; the golden test pins both.
// Wording rules: D-051, no italics, no dashes. The environment word is never typed on a page: it is
// taken from the stored environment by environmentWord.
import type { EnvironmentLabel } from '@umsbx/contracts';
import { formatMinor } from './format';

export const NAV_SALES = 'Sales';
export const NAV_STATEMENT = 'Statement';
export const NAV_HOME = 'Publisher home';

export const SALES_HEADING = 'Sales';
export const SALES_LEDE =
  'One line for each unit you sold. Every figure is read from a stored record.';
export const SALES_EMPTY_TITLE = 'No sales yet.';
export const SALES_EMPTY_BODY =
  'When a buyer pays for one of your offers, the sale is listed here.';
export const SALES_COLUMNS = {
  date: 'Date',
  order: 'Order',
  article: 'Article',
  access: 'Access',
  amount: 'Amount',
  fee: 'PayPal fee',
  status: 'Status',
} as const;
// PUB-F1: the totals row is the statement block, so the figures match S5. The fee sits beside the net.
export const TOTALS_HEADING = 'Totals';
export const TOTALS_COLUMNS = {
  group: 'Currency',
  units: 'Paid units',
  gross: 'Gross',
  refunds: 'Refunds',
  reversals: 'Reversals',
  net: 'Net',
  fee: 'PayPal fee',
} as const;
export const TOTALS_NOTE =
  'Totals are the statement figures, added up from the same ledger rows. The PayPal fee is shown beside the net and is not subtracted.';
export const FEE_NOT_REPORTED = 'Not reported';

/** GATE35 D5: a dry run reports no fee, so a stored value in a dry run is never shown as one. */
export function feeText(
  fee: number | null,
  currency: string,
  environment: EnvironmentLabel,
): string {
  return fee === null || environment === 'dryrun' ? FEE_NOT_REPORTED : formatMinor(fee, currency);
}

/** In a dry run nothing reported a fee, so fee ledger lines are left out of the lines table too. */
export function visibleLines<T extends { kind: string }>(
  lines: readonly T[],
  environment: EnvironmentLabel,
): T[] {
  return lines.filter((l) => !(environment === 'dryrun' && l.kind === 'paypal_fee'));
}

// GATE35 D6: a unit counts as a sale on the sales page once it has been paid. Awaiting payment, pending
// at PayPal and declined units are not counted there, and the statement (ledger sale rows) does not
// count them either. A `mismatch` unit is different: it IS counted on the sales page (it is not in the
// list below), but the statement has no sale row for it, because the ledger writes a sale row only for
// a verified capture. The two pages therefore differ for a mismatch unit until the owner decides
// assumption 30. Both pages say so with MISMATCH_NOTE; the counting is unchanged.
const NOT_A_SALE: readonly string[] = ['expected', 'pending', 'declined'];
export const isCountedSale = (status: string): boolean => !NOT_A_SALE.includes(status);

export function splitSales<T extends { status: string }>(
  rows: readonly T[],
): { counted: T[]; notCounted: T[] } {
  return {
    counted: rows.filter((r) => isCountedSale(r.status)),
    notCounted: rows.filter((r) => !isCountedSale(r.status)),
  };
}

export const notCountedText = (n: number): string =>
  `Awaiting payment, not counted: ${String(n)} ${n === 1 ? 'unit' : 'units'}.`;

/** A unit whose amount disagreed with the quote: shown on the sales page, not added up on the statement. */
export const MISMATCH_NOTE = 'Amount disagreed with the quote: under review.';
const unitsAre = (n: number): string => `${String(n)} ${n === 1 ? 'unit is' : 'units are'}`;
export const mismatchSalesText = (n: number): string =>
  `${MISMATCH_NOTE} ${unitsAre(n)} listed above but not added up on the statement.`;
export const mismatchStatementText = (n: number): string =>
  `${MISMATCH_NOTE} ${unitsAre(n)} listed on the sales page but not added up here.`;

export const SALES_SOURCE_NOTE =
  'Source: the stored order units. The PayPal fee is shown only when PayPal reported it.';
export const SALES_ORDER_NOTE = 'Order shows the last 6 characters of the order reference.';

/** D-051: the verb follows the count. */
export function salesCountText(n: number): string {
  if (n === 0) return 'No sales yet.';
  if (n === 1) return '1 sale is listed.';
  return `${String(n)} sales are listed.`;
}

export const STATEMENT_HEADING = 'Statement';
export const STATEMENT_LEDE =
  'Your sales, refunds and reversals by currency, added up from the stored ledger.';
export const STATEMENT_EMPTY_TITLE = 'No sales yet.';
export const STATEMENT_EMPTY_BODY =
  'When a buyer pays for one of your offers, its ledger lines are added up here.';
export const SETTLEMENT_HEADING = 'Where the money is';
export const COMMISSION_HEADING = 'Commission';

export const LINE_LABEL = {
  sales: 'Sales',
  refunds: 'Refunds',
  reversals: 'Reversals',
  fee: 'PayPal fees observed',
  net: 'Net',
} as const;

/** Every money line carries one of these. */
export const LINE_SOURCE = {
  sales: 'Source: ledger sale rows.',
  refunds: 'Source: ledger refund rows.',
  reversals: 'Source: ledger reversal rows.',
  fee: 'Source: ledger PayPal fee rows. Shown for information and not subtracted from the net.',
  net: 'Source: sales minus refunds minus reversals, from the same ledger rows.',
} as const;

export const LINES_HEADING = 'Ledger lines';
export const LINES_COLUMNS = {
  date: 'Date',
  order: 'Order',
  entry: 'Entry',
  amount: 'Amount',
} as const;
export const ENTRY_TEXT = {
  sale: 'Sale',
  refund: 'Refund',
  reversal: 'Reversal',
  paypal_fee: 'PayPal fee',
} as const;

/** The label word comes from the stored environment of the rows (or the app), never from a typed string. */
export function environmentWord(environment: EnvironmentLabel): string {
  return environment === 'sandbox' ? 'Sandbox' : 'Dry run';
}

export function blockHeading(currency: string, environment: EnvironmentLabel): string {
  return `${currency}, ${environmentWord(environment)}`;
}

/** The statement line for an order links to its row on the sales page. */
export function salesAnchor(orderRef6: string): string {
  return `/publisher/sales#order-${orderRef6}`;
}
