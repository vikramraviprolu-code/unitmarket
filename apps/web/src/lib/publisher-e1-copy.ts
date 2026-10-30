// The words of the PUB-E1 publisher features: CSV download links, the Refunds section of the sales page,
// "Since your last visit" on the publisher home, and the create an offer page. Pure: no server module, no
// clock. Wording rules: D-051 (the verb follows the count), no italics, no dashes. The environment word
// (Sandbox or Dry run) is never typed here: it comes from the stored environment.
import { offerErrorText } from './offer-copy';

// CSV
export const EXPORT_SALES_HREF = '/api/publisher/export?kind=sales';
export const EXPORT_STATEMENT_HREF = '/api/publisher/export?kind=statement';
export const EXPORT_SALES_LABEL = 'Download sales as CSV';
export const EXPORT_STATEMENT_LABEL = 'Download statement as CSV';
export const EXPORT_FAILED = 'The file could not be made. Try again.';
export const EXPORT_TRUNCATED =
  'The file lists the first 5000 rows only. The totals in a statement still cover every row.';
export const EXPORT_NOTE =
  'The file has one row per line, amounts in minor units and as decimals, and a currency column. Order references show the last 6 characters. No buyer is named.';

// Refunds
export const REFUNDS_HEADING = 'Refunds';
export const REFUNDS_LEDE =
  'Units that were refunded, partly refunded, held after a possible reversal, or reversed.';
export const REFUNDS_EMPTY = 'No refunds yet.';
export const REFUNDS_COLUMNS = {
  date: 'Date',
  order: 'Order',
  article: 'Article',
  original: 'Original amount',
  refunded: 'Refunded',
  reversed: 'Reversed',
  status: 'Status',
} as const;
export const REFUNDS_SOURCE_NOTE =
  'Source: the stored ledger. A held unit has no refund row yet, so its date is the last change to the unit.';

/** D-051: the verb follows the count. */
export function refundsCountText(n: number): string {
  if (n === 0) return REFUNDS_EMPTY;
  if (n === 1) return '1 unit is listed.';
  return `${String(n)} units are listed.`;
}

// Since your last visit
export const SINCE_HEADING = 'Since your last visit';
export const SINCE_FIRST =
  'This is your first visit. Changes are listed here from your next visit.';
export const SINCE_NONE = 'Nothing new since your last visit.';
export const sinceFromText = (when: string): string => `Counted from ${when}.`;

export interface SinceCountsInput {
  new_sales: number;
  refunds: number;
  operator_offer_changes: number;
  payee_decisions: number;
}

/** One sentence per kind that is not zero, in a fixed order. D-051 agreement. */
export function sinceLines(c: SinceCountsInput): string[] {
  const out: string[] = [];
  const n = (k: number, one: string, many: string): string =>
    `${String(k)} ${k === 1 ? one : many}`;
  if (c.new_sales > 0) out.push(`${n(c.new_sales, 'new sale', 'new sales')}.`);
  if (c.refunds > 0) out.push(`${n(c.refunds, 'refund', 'refunds')}.`);
  if (c.operator_offer_changes > 0)
    out.push(
      `${n(c.operator_offer_changes, 'change', 'changes')} to your offers or your account by an operator.`,
    );
  if (c.payee_decisions > 0)
    out.push(`${n(c.payee_decisions, 'payee decision', 'payee decisions')}.`);
  return out;
}

// Create an offer
export const CREATE_LINK = 'Create an offer';
export const CREATE_HEADING = 'Create an offer';
export const CREATE_LEDE =
  'Put one of your articles on sale. Choose the article, the options and the price of each option.';
export const CREATE_NONE_TITLE = 'No article to offer';
export const CREATE_NONE_BODY = 'Every article of yours already has an offer on sale.';
export const CREATE_ARTICLE_LABEL = 'Article';
export const CREATE_BACK = 'Back to your offers';
export const CREATE_LABEL = 'Put this article on sale';
export const CREATE_TERMS_NOTE = (terms: string): string =>
  `Terms version ${terms}. The access window is set by UnitMarket. Personal use only. No redistribution. AI assistants may read it for the buyer after the buyer reviews it.`;
export const createdText = (version: string): string =>
  `Created. This offer is on sale as version ${version}.`;

export function createErrorText(code: string): string {
  switch (code) {
    case 'already_offered':
      return 'This article already has an offer on sale.';
    case 'no_corridor':
      return 'No sales route is set up for your country, so nothing can be offered yet.';
    default:
      return offerErrorText(code);
  }
}
