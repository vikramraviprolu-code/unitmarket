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

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'for',
  'to',
  'and',
  'on',
  'at',
  'by',
  'with',
]);

/**
 * Two letters for a cover from the title: the first letters of the first two significant words, so
 * "A notebook of six working knots" reads NS. Stop words are skipped; a title made only of them keeps them.
 */
export function offerInitials(title: string): string {
  const words = title.match(/\p{L}+/gu) ?? [];
  const significant = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  return coverInitials((significant.length > 0 ? significant : words).join(' '));
}
