// INT-SEL / SEL.2: the three views of the seller Sales page and their words. The views are plain query maps
// over SR1's seller list; the filter bar shows seller fields only (REFUSED_FIELDS removes the rest). Pure.
import { formatDateTime, formatMinor, optionLabel } from './format';
import type { TxnLine } from '@umsbx/contracts';

export const SALES_TABS = ['all', 'pending', 'refunds'] as const;
export type SalesTab = (typeof SALES_TABS)[number];

export const TAB_LABEL: Record<SalesTab, string> = {
  all: 'All',
  pending: 'Pending',
  refunds: 'Refunds',
};

/** The URL map of one view. Pending is the "in progress" group: bought, not yet paid in full. */
export function salesTabQuery(tab: SalesTab): Record<string, string> {
  switch (tab) {
    case 'all':
      return {};
    case 'pending':
      return { status: 'in_progress' };
    case 'refunds':
      return { refund: 'partial,full' };
  }
}

export function parseSalesTab(raw: string | string[] | undefined): SalesTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return SALES_TABS.find((t) => t === v) ?? 'all';
}

export interface SalesCounts {
  all: number;
  pending: number;
  refunds: number;
}

export const tabText = (tab: SalesTab, counts: SalesCounts): string =>
  `${TAB_LABEL[tab]} (${String(counts[tab])})`;

export const SALES_NAV_LABEL = 'Sales views';
export const SALES_EMPTY = 'No sales to show for this view.';
export const SALES_EXPORT_LABEL = 'Download these sales as CSV';
export const SALES_EXPORT_HREF = '/api/publisher/sales/export';
export const OPEN_SALE = 'Open sale';
export const MORE_SALES = 'Show more sales';

/** The link of a view, keeping the other filters out: a view replaces the filter set. */
export function tabHref(tab: SalesTab): string {
  return tab === 'all' ? '/publisher/sales' : `/publisher/sales?view=${tab}`;
}

export interface SalesRowView {
  unit_id: string;
  href: string;
  when: string;
  ref6: string;
  titles: string;
  amount: string;
  status: string;
  channel: string;
}

export const channelWord = (c: 'human' | 'agent'): string =>
  c === 'agent' ? 'an agent' : 'a person';

export function salesRows(lines: readonly TxnLine[]): SalesRowView[] {
  return lines.map((l) => ({
    unit_id: l.unit_id,
    href: `/publisher/sales/${encodeURIComponent(l.unit_id)}`,
    when: formatDateTime(l.created_at),
    ref6: l.order_ref6,
    titles: l.titles.join(', '),
    amount: formatMinor(l.amount_minor, l.currency),
    status: l.status,
    channel: channelWord(l.channel),
  }));
}

export { optionLabel };
