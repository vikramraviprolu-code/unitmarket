// computeFit: pure, deterministic, honest. The band is derived from the dimension levels alone;
// ranking is advice and the buyer chooses (architecture 9.11).
import type { ArticleFacts, Brief, FitCard, FitDimension, Offer } from '@umsbx/contracts';
import {
  accessDimension,
  budgetDimension,
  languageDimension,
  recencyDimension,
  topicDimension,
} from './levels';

export function bandOf(dimensions: FitDimension[]): FitCard['band'] {
  const levels = dimensions.flatMap((d) => (d.level === null ? [] : [d.level]));
  if (levels.length < 2) return null;
  if (levels.length >= 3 && levels.every((l) => l >= 2)) return 'strong';
  // mean >= 1.5 without division: 2 * sum >= 3 * count
  const sum = levels.reduce<number>((s, l) => s + l, 0);
  return 2 * sum >= 3 * levels.length ? 'good' : 'partial';
}

export function computeFit(
  brief: Brief,
  facts: { offer: Offer; article: ArticleFacts; price_minor: number; minor_units?: number },
  now: Date,
): FitCard {
  const { offer, article, price_minor, minor_units } = facts;
  const dimensions: FitDimension[] = [
    topicDimension(brief, article),
    budgetDimension(brief, offer, price_minor, minor_units),
    accessDimension(brief, offer),
    languageDimension(brief, article),
    recencyDimension(article, now),
  ];
  return { offer_id: offer.id, dimensions, band: bandOf(dimensions) };
}

const BAND_RANK = { strong: 0, good: 1, partial: 2 } as const;
const levelSum = (c: FitCard): number => c.dimensions.reduce((s, d) => s + (d.level ?? 0), 0);

// Band, then sum of levels (higher first), then price (lower first), then offer id. Returns a new array.
export function rankFit<T extends { fit: FitCard; price_minor: number }>(items: readonly T[]): T[] {
  const band = (c: FitCard): number => (c.band === null ? 3 : BAND_RANK[c.band]);
  return [...items].sort(
    (a, b) =>
      band(a.fit) - band(b.fit) ||
      levelSum(b.fit) - levelSum(a.fit) ||
      a.price_minor - b.price_minor ||
      (a.fit.offer_id < b.fit.offer_id ? -1 : a.fit.offer_id > b.fit.offer_id ? 1 : 0),
  );
}
