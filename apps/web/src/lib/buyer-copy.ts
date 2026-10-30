// Buyer-facing wording for the search, results and library screens. Pure; kept out of the .tsx files so
// unit tests can pin it (the unit runner does not compile .tsx). Wording rules: D-051.
import type { FitDimension, Rights } from '@umsbx/contracts';
import { OPTION_LABEL, formatMinor } from './format';
import type { OfferPage } from './view-types';
import { LINE_TEXT } from './composite-copy';

// U3: the terms, shown where the buyer accepts them. The first line is the offer page's sentence and the
// second and third restate the approval page's, so the three screens say the same thing.
export const TERMS_SUMMARY = 'What the terms say';
export const TERMS_POINTS = [
  'Personal use only. No redistribution.',
  'Five days of access, starting when payment is confirmed.',
  'Once you start to buy, the price and these terms are held for 15 minutes.',
] as const;

// Item 50: the full terms, from the offer's stored rights, shown before the tick. The AI-use line is the
// only one that varies by offer; the others are the platform's. Wording of the AI line needs the owner's eye.
const AI_LINE: Record<Rights['ai_scope'], string> = {
  agent_allowed: 'The publisher allows you to use this article with AI tools, for your own use.',
  review: 'This purchase does not include use with AI tools.',
  not_allowed: 'The publisher does not allow use of this article with AI tools.',
};

// One Rights (an offer page) or several (a list of offers): each distinct AI-use line is printed once.
export function termsPoints(rights?: Rights | readonly Rights[]): string[] {
  const list: readonly Rights[] =
    rights === undefined ? [] : 'ai_scope' in rights ? [rights] : (rights as readonly Rights[]);
  const lines = [...new Set(list.map((r) => AI_LINE[r.ai_scope]))];
  return [...TERMS_POINTS, ...lines];
}

// Item 46: when a search finds nothing, the whole catalogue is listed instead of a dead end.
export const BROWSE_HEADING = 'Browse all articles';
export const BROWSE_EMPTY = 'The catalogue has no articles right now.';

export function browseLinkText(count: number): string {
  return count === 1 ? 'Browse the 1 article' : `Browse all ${String(count)} articles`;
}

export interface BrowseEntry {
  offer_id: string;
  title: string;
  publisher: string;
  href: string;
  price_text: string;
}

export function browseEntries(offers: readonly OfferPage[]): BrowseEntry[] {
  return offers.map((o) => ({
    offer_id: o.offer_id,
    title: o.title,
    publisher: o.publisher,
    href: `/o/${o.publisher_slug}/${o.offer_code}`,
    price_text:
      o.options.length === 0
        ? ''
        : `from ${formatMinor(Math.min(...o.options.map((x) => x.price_minor)), o.currency)}`,
  }));
}

// U1: one statement of the end of the access window, by what the buyer bought.
export function windowUntilLine(option: string | undefined, dateText: string): string {
  return option === 'keep_retrieve' ? `Download until ${dateText}` : `Access until ${dateText}`;
}

// U4: the fit card's price line and the access days under it.
export const WHY_THIS_FIT = 'Why this fit';

export function priceLine(priceText: string, option: keyof typeof OPTION_LABEL): string {
  return `${priceText} · ${OPTION_LABEL[option]}`;
}

export function accessDaysLine(option: keyof typeof OPTION_LABEL): string {
  return option === 'keep_retrieve' ? '5 days to download your copy' : '5 days to read';
}

// Rows with a real assessment stay on the card; rows that could not be assessed go into the details.
export function splitFitRows(dimensions: readonly FitDimension[]): {
  assessed: FitDimension[];
  notAssessed: FitDimension[];
} {
  return {
    assessed: dimensions.filter((d) => d.level !== null),
    notAssessed: dimensions.filter((d) => d.level === null),
  };
}

/** The stored money state of one item in plain words (gate 12 D12). The words match the order page lines. */
export function moneyStateText(money: string): string {
  switch (money) {
    case 'pending':
      return LINE_TEXT.pending;
    case 'captured':
      return 'Paid';
    case 'denied':
      return LINE_TEXT.declined;
    case 'refunded':
      return 'Refunded';
    case 'reversed':
      return 'Payment reversed';
    default:
      return LINE_TEXT.confirming;
  }
}
