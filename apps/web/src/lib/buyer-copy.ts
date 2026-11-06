// Buyer-facing wording for the search, results and library screens. Pure; kept out of the .tsx files so
// unit tests can pin it (the unit runner does not compile .tsx). Wording rules: D-051.
import type { FitDimension, Rights } from '@umsbx/contracts';
import { DEFAULT_ACCESS_DAYS, OPTION_LABEL, formatDateTime, formatMinor } from './format';
import { NO_RATE_NOTE, fromLead, priceView } from './buyer-price';
import type { PriceView } from './buyer-price';
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
  /** MC2-L5: the binding seller amount beside a converted price; null when nothing was converted. */
  binding_text: string | null;
}

// MC2-L5: `view` is the buyer's display (server/buyer-display.ts); without it the seller's currency is shown.
export function browseEntries(
  offers: readonly OfferPage[],
  view: (price: { currency: string; minor: number }) => PriceView = (m) => priceView(m, null),
): BrowseEntry[] {
  return offers.map((o) => {
    const cheapest =
      o.options.length === 0 ? null : Math.min(...o.options.map((x) => x.price_minor));
    const price = cheapest === null ? null : view({ currency: o.currency, minor: cheapest });
    return {
      offer_id: o.offer_id,
      title: o.title,
      publisher: o.publisher,
      href: `/o/${o.publisher_slug}/${o.offer_code}`,
      price_text: price === null ? '' : fromLead(price),
      binding_text: price === null ? null : price.binding,
    };
  });
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

// BR-3: `days` comes from the frozen terms or the entitlement when there is one; without it the platform default.
export function accessDaysLine(
  option: keyof typeof OPTION_LABEL,
  days: number = DEFAULT_ACCESS_DAYS,
): string {
  const n = `${days} ${days === 1 ? 'day' : 'days'}`;
  return option === 'keep_retrieve' ? `${n} to download your copy` : `${n} to read`;
}

// The approval screen: the same sentence the buyer is about to agree to, with the frozen days.
export const TERMS_INVALID_TEXT =
  'We could not work out the terms of this purchase. Please try again later.';

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
export function moneyStateText(money: string, unpaid = false): string {
  // GATE35 D2: an order the buyer never approved is "Not paid yet", the library's words, not a payment pending at PayPal.
  if (unpaid) return NOT_PAID_SHORT;
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

// FIX-FLOW D4: an order the buyer left at the pay page. It says what is true (no payment received) and
// never "Confirming payment", which is for a payment that PayPal has approved or captured.
export const NOT_PAID_SHORT = 'Not paid yet';
export const NOT_PAID_YET = `${NOT_PAID_SHORT}. We have not received a payment for this order.`;

/** GATE35 D2: a receipt link is offered only when a receipt version exists, so it never leads to a 404. */
export function hasReceipt(item: {
  order_id: string | null;
  receipt_versions: readonly number[];
}): boolean {
  return item.order_id !== null && item.receipt_versions.length > 0;
}

// FIX-FLOW D5: a search whose only matches are articles the buyer already holds, or has an open unpaid
// order for, is not "nothing fits". The discovery answer carries the reasons; the form says this.
// GATEFIX2: the two are said apart. "In your library" is only for a paid article; an open unpaid order
// is called that, and the buyer is sent to where the order can be continued or cancelled.
export const OPEN_ORDER_HEADING = 'Already in your library';
export const OPEN_ORDER_BODY = 'Some articles that fit are already in your library.';
export const OPEN_ORDER_LINK = 'Open My library';
export const UNPAID_ORDER_HEADING = 'You have an unpaid order';
export const UNPAID_ORDER_BODY =
  'You have an unpaid order for an article that fits. Open your library to find it, then continue to payment or cancel it.';

export interface DiscoverNoMatchView {
  /** The open order notice, or null when no reason says an article is already held. */
  open_order: { heading: string; body: string; href: string } | null;
  /** Whether to also say "nothing in the catalogue fits" (false when the notice is the whole story). */
  nothing_fits: boolean;
  /** MC2-L5: said when some prices could not be compared with the ceiling for want of a rate; else null. */
  no_rate: string | null;
}

export function discoverNoMatchView(
  reasons: readonly string[],
  rateMissing = false,
): DiscoverNoMatchView {
  const owned = reasons.includes('already_owned');
  const unpaid = reasons.includes('unpaid_order');
  const held = owned || unpaid;
  const open_order =
    owned && unpaid
      ? {
          heading: UNPAID_ORDER_HEADING,
          body: `${OPEN_ORDER_BODY} ${UNPAID_ORDER_BODY}`,
          href: '/library',
        }
      : owned
        ? { heading: OPEN_ORDER_HEADING, body: OPEN_ORDER_BODY, href: '/library' }
        : unpaid
          ? { heading: UNPAID_ORDER_HEADING, body: UNPAID_ORDER_BODY, href: '/library' }
          : null;
  return {
    open_order,
    nothing_fits: !held || reasons.some((r) => r !== 'already_owned' && r !== 'unpaid_order'),
    no_rate: rateMissing ? NO_RATE_NOTE : null,
  };
}

// BR-4: the refund deadline a buyer reads on the library item and the receipt. The date is the deadline in the
// sale's frozen terms; the words never name a number of days (D-051), so a different window needs no new copy.
// A sale approved before the terms were recorded has no deadline and no line.
export type RefundWindowView =
  | { state: 'open'; deadline: string }
  | { state: 'ended'; deadline: string }
  | { state: 'none' }
  /** Operator panel only: past the deadline, but the buyer's refund case was opened in time, so no override is needed. */
  | { state: 'asked_in_time'; deadline: string }
  /** The sale's terms could not be read: no date is shown, and the operator needs a reason to refund. */
  | { state: 'unknown' };

/** Open strictly before the deadline, ended at it and after it, none without one. */
export function refundWindowView(deadline: string | null, nowIso: string): RefundWindowView {
  if (deadline === null) return { state: 'none' };
  return new Date(nowIso).getTime() < new Date(deadline).getTime()
    ? { state: 'open', deadline }
    : { state: 'ended', deadline };
}

export const REFUND_PERIOD_ENDED = 'Refund period ended';

export function refundWindowLine(v: RefundWindowView): string | null {
  switch (v.state) {
    case 'open':
      return `Refunds can be requested until ${formatDateTime(v.deadline)}`;
    case 'ended':
    case 'asked_in_time':
      return REFUND_PERIOD_ENDED;
    case 'none':
    case 'unknown':
      return null;
  }
}

// INT-BUY / BUY.1: the sentence a buyer reads before it gives an agent a spending cap. The confirm button under it
// sets terms_accepted, so the sentence is the whole of what is agreed. Additive: nothing above changes.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "30 Nov": the day of an ISO time in UTC, as the cap sentences write it. */
export function capDay(isoUtc: string): string {
  const d = new Date(isoUtc);
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]!}`;
}

export const purchasesWord = (n: number): string =>
  `${String(n)} ${n === 1 ? 'purchase' : 'purchases'}`;

export function capConfirmSentence(i: {
  currency: string;
  max_total_minor: number | null;
  max_count: number | null;
  expires_at: string;
}): string {
  const spend =
    i.max_total_minor === null ? null : `spend up to ${formatMinor(i.max_total_minor, i.currency)}`;
  const buy = i.max_count === null ? null : `make up to ${purchasesWord(i.max_count)}`;
  const what = [spend, buy].filter((x): x is string => x !== null).join(' and ');
  return `Your agent may ${what} until ${capDay(i.expires_at)}.`;
}

export const CAP_CONFIRM_BUTTON = 'Confirm and set the cap';
export const CAP_CONFIRM_NOTE =
  'The cap limits what your agent can spend. You can end it at any moment.';
export const CAP_NO_KEYS =
  'You have no agent key yet. Make one under API keys, then come back to give it a cap.';
