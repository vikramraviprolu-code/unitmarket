// The words the publisher sales page (S4) and statement page (S5) show (PUB-C). Pure: no server module,
// no clock. The money words themselves (status words, the settlement sentence, the commission line)
// live in @umsbx/publisher-console next to the code that decides them; the golden test pins both.
// Wording rules: D-051, no italics, no dashes. The environment word is never typed on a page: it is
// taken from the stored environment by environmentWord.
import type { EnvironmentLabel } from '@umsbx/contracts';

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
export const FEE_NOT_REPORTED = 'Not reported';
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
