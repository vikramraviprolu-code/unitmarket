// INT-BUY / BUY.4: the logic of the Spending page. Pure. Lines come from SR1's buyer read; this turns them into
// rows in words. The filter bar is the shared one with the buyer's fields (the bar leaves out what the server would
// refuse for a buyer).
import type { TxnLine } from '@umsbx/contracts';
import { formatDateTime, formatMinor } from './format';
import { STATUS_LABEL } from './filter-bar-view';
import type { BarContext } from './filter-bar-view';

export const SPENDING_FILTER_CONTEXT: BarContext = { kind: 'txn', persona: 'buyer' };
export const SPENDING_EMPTY =
  'You have not bought anything that matches. When you do, it shows here with its status.';
export const SPENDING_TITLE = 'Spending';
export const SPENDING_LEDE =
  'Everything you or your agents bought. Filters stay in the address, so a filtered list can be bookmarked.';
export const SPENDING_EXPORT_LABEL = 'Download as CSV';

export interface SpendingRow {
  key: string;
  when: string;
  order_ref: string;
  href: string;
  items: string;
  money_text: string;
  refunded_text: string | null;
  status_word: string;
  by: 'You' | 'Your agent';
  environment: string;
}
export interface SpendingModel {
  rows: SpendingRow[];
  empty: string | null;
}

export function spendingModel(lines: readonly TxnLine[], now: Date): SpendingModel {
  void now; // kept so every buyer model takes the clock the same way; dates are shown as stored
  const rows = lines.map((l): SpendingRow => ({
    key: l.unit_id,
    when: formatDateTime(l.created_at),
    order_ref: l.order_ref,
    href: `/orders/${encodeURIComponent(l.order_ref)}`,
    items: l.titles.join(', '),
    money_text: formatMinor(l.amount_minor, l.currency),
    refunded_text: l.refunded_minor > 0 ? formatMinor(l.refunded_minor, l.currency) : null,
    status_word: STATUS_LABEL[l.status],
    by: l.channel === 'agent' ? 'Your agent' : 'You',
    environment: l.environment,
  }));
  return { rows, empty: rows.length === 0 ? SPENDING_EMPTY : null };
}
