// PUB-UI-OFFERS: pure view logic for the publisher offers list. Filtering works on the rows the page already
// has; nothing here reads a clock, a random source or the network.
import { coverInitials } from './cover';
import {
  FILTER_ALL,
  FILTER_DRAFT,
  FILTER_ON_SALE,
  FILTER_WITHDRAWN,
  type OfferStatus,
} from './offer-copy';

export type OfferFilter = 'all' | 'on_sale' | 'draft' | 'withdrawn';
export type StatusFilter = Exclude<OfferFilter, 'all'>;
export type ChipTone = 'good' | 'warn' | 'neutral';

export const OFFER_FILTERS: readonly OfferFilter[] = ['all', 'on_sale', 'draft', 'withdrawn'];

const FILTER_WORD: Record<OfferFilter, string> = {
  all: FILTER_ALL,
  on_sale: FILTER_ON_SALE,
  draft: FILTER_DRAFT,
  withdrawn: FILTER_WITHDRAWN,
};

/** The tab named by the query string; a missing, repeated or unknown value reads as all. */
export function parseOfferFilter(raw: string | string[] | undefined): OfferFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return OFFER_FILTERS.find((f) => f === v) ?? 'all';
}

export const statusFilter = (s: OfferStatus): StatusFilter => (s === 'authorised' ? 'on_sale' : s);

export function statusTone(s: OfferStatus): ChipTone {
  if (s === 'authorised') return 'good';
  return s === 'draft' ? 'warn' : 'neutral';
}

export function filterCounts(
  rows: readonly { status: OfferStatus }[],
): Record<OfferFilter, number> {
  const c: Record<OfferFilter, number> = { all: rows.length, on_sale: 0, draft: 0, withdrawn: 0 };
  for (const r of rows) c[statusFilter(r.status)] += 1;
  return c;
}

/** The rows of one tab, in the order given. */
export function filterOffers<T extends { status: OfferStatus }>(
  rows: readonly T[],
  f: OfferFilter,
): T[] {
  return f === 'all' ? [...rows] : rows.filter((r) => statusFilter(r.status) === f);
}

export const tabText = (f: OfferFilter, count: number): string =>
  `${FILTER_WORD[f]} (${String(count)})`;

export const filterHref = (f: OfferFilter): string => `/publisher/offers?status=${f}`;

const LEADING_ARTICLE = /^\s*(?:a|an|the)\s+(?=\p{L})/iu;

/** Two letters for a cover: a leading article is skipped, so "A morning walk" reads MW. */
export const offerInitials = (title: string): string =>
  coverInitials(title.replace(LEADING_ARTICLE, ''));
