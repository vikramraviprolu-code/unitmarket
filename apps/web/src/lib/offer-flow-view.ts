// GATEFIX2 items 3, 5 and 7: the words and decisions of the buyer offer page. Pure: no server module, no
// clock (the caller passes the time). Wording rules: D-051, no italics, no dashes.

export const UNPAID_ORDER_HEADING = 'You have an unpaid order';
export const UNPAID_ORDER_TEXT =
  'You have an unpaid order for this article. Open it to continue to payment or to cancel it.';
export const UNPAID_ORDER_LINK = 'Open your order';
export const LIBRARY_LINK = 'Open My library';
export const NOT_ON_SALE_HEADING = 'Not on sale';
export const NOT_ON_SALE_BODY =
  'This offer is not on sale right now, so there is no price to show. You can look for other articles.';
export const PRICE_GONE_TITLE = 'This price is no longer available';
export const PRICE_GONE_BODY =
  'The price you were shown can no longer be used. Choose Show my price to see the current one.';

const REASON: Record<string, string> = {
  above_ceiling:
    'This article costs more than your ceiling. We do not swap in other articles on our own. You can raise your ceiling or look at other articles yourself.',
  withdrawn: 'The publisher has withdrawn this offer.',
  not_authorised: 'This offer is not available right now.',
  corridor_unsupported: 'This offer is not available in your country yet.',
  already_owned: 'You already have this article in your library.',
  unpaid_order: UNPAID_ORDER_TEXT,
  below_publisher_floor: 'That price is below what the publisher will accept.',
  option_not_offered: 'The publisher does not sell that way for this article.',
};

export interface NoMatchView {
  heading: string;
  text: string;
  link: { href: string; text: string } | null;
}

/** The no-match banner: unpaid order links to the order (or to My library when the order is not known). */
export function noMatchView(reason: string, orderRef: string | undefined): NoMatchView {
  const text = REASON[reason] ?? 'There is no match for this request.';
  if (reason === 'unpaid_order') {
    return {
      heading: UNPAID_ORDER_HEADING,
      text,
      link:
        orderRef !== undefined && orderRef !== ''
          ? { href: `/orders/${encodeURIComponent(orderRef)}`, text: UNPAID_ORDER_LINK }
          : { href: '/library', text: LIBRARY_LINK },
    };
  }
  return { heading: 'No match', text, link: null };
}

export interface RefusedQuoteView {
  /** True when the price card must go: its quote can no longer be approved. */
  hideQuote: boolean;
  title: string;
  body: string;
}

/** What "Review and approve" shows when the server refuses the quote. One message, and no stale card. */
export function refusedQuoteView(code: string, message: string): RefusedQuoteView {
  if (code === 'quote_expired' || code === 'offer_changed') {
    return { hideQuote: true, title: PRICE_GONE_TITLE, body: PRICE_GONE_BODY };
  }
  return { hideQuote: false, title: 'We could not continue', body: message };
}

export interface OnSaleFacts {
  status: string;
  superseded_by: string | null;
  publisher_status: string;
  valid_from: string;
  valid_until: string | null;
  now_ms: number;
}

/** The same tests startFromOffer applies before it quotes, from stored facts. */
export function offerOnSale(f: OnSaleFacts): boolean {
  return (
    f.status === 'authorised' &&
    f.superseded_by === null &&
    f.publisher_status === 'active' &&
    f.now_ms >= Date.parse(f.valid_from) &&
    (f.valid_until === null || f.now_ms < Date.parse(f.valid_until))
  );
}
