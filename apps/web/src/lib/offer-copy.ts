// The words the offers list (S2) and the offer page (S3) show (PUB-B). Pure: no server module, no
// clock. The pages and the form take their sentences from here, and the golden test pins them.
// Wording rules: D-051, no italics, no dashes. The environment word (Sandbox or Dry run) is never typed
// here: the pages take it from the stored environment. Prices are typed in major units (2.50) and
// sent in minor units (250); the corridors in use have two decimal places.
import { formatMinor, optionLabel } from './format';

export type OfferStatus = 'draft' | 'authorised' | 'withdrawn';
export type OptionId = 'keep_retrieve' | 'online_read';

// S2: the list
export const OFFERS_HEADING = 'Your offers';
export const OFFERS_LEDE =
  'Each offer is one article on sale. Open an offer to change its price or take it off sale.';
export const COL_ARTICLE = 'Article';
export const COL_OPTIONS = 'Options and prices';
export const COL_STATUS = 'Status';
export const COL_ACTION = 'Change';
export const OFFERS_EMPTY_TITLE = 'No offers yet';
export const OFFERS_EMPTY_BODY = 'When an offer is created for your articles it appears here.';
export const NOT_OFFERED = 'Not offered';

export function offerStatusText(s: OfferStatus): string {
  switch (s) {
    case 'authorised':
      return 'On sale';
    case 'withdrawn':
      return 'Withdrawn';
    case 'draft':
      return 'Draft';
  }
}

/** Version history: only the newest version of an authorised offer is on sale; older ones were replaced. */
export function historyStatusText(s: OfferStatus, newest: boolean): string {
  return s === 'authorised' && !newest ? 'Replaced by a newer version' : offerStatusText(s);
}

export const optionPriceText = (option: string, minor: number, currency: string): string =>
  `${optionLabel(option)}: ${formatMinor(minor, currency)}`;

export const editLinkText = (title: string): string => `Change ${title}`;

// S3: one offer
export const BACK_TO_OFFERS = 'Back to your offers';
export const OFFER_LEDE =
  'Set the price of each option, choose which options are offered, then save. Saving makes a new version of the offer.';
export const LABEL_ARTICLE = 'Article';
export const LABEL_STATUS = 'Status';
export const LABEL_VERSION = 'Version';
export const LABEL_CURRENCY = 'Currency';
export const OPTIONS_HEADING = 'Options and prices';
export const offeredLabel = (option: string): string => `Offer ${optionLabel(option)}`;
export const priceLabel = (option: string, currency: string): string =>
  `Price for ${optionLabel(option)} (${currency})`;
export const priceHint = (min: string, max: string): string => `From ${min} to ${max}.`;
export const LABEL_WINDOW = 'Access window';
export const WINDOW_VALUE = 'Set by UnitMarket';
export const LABEL_LICENCE = 'Licence';
export const LABEL_TERMS = 'Terms version';

export function licenceText(r: {
  scope: 'personal_use';
  ai_scope: 'agent_allowed' | 'review' | 'not_allowed';
  redistribution: false;
}): string {
  const ai =
    r.ai_scope === 'agent_allowed'
      ? 'AI assistants may read it for the buyer.'
      : r.ai_scope === 'review'
        ? 'AI assistants may read it for the buyer after the buyer reviews it.'
        : 'AI assistants may not read it.';
  return `Personal use only. No redistribution. ${ai}`;
}

export const ATTEST_LABEL =
  'I confirm that I hold the rights to sell this article at this price on these terms.';
export const SAVE_LABEL = 'Save as new version';
export const savedText = (version: string): string => `Saved. This is now version ${version}.`;
export const FREEZE_NOTE = 'Buyers who already approved keep the price they saw.';
export const WITHDRAWN_NOTICE = 'This offer is withdrawn. It cannot be changed here.';
export const DRAFT_NOTICE = 'This offer is a draft and is not on sale. It cannot be changed here.';

export const WITHDRAW_HEADING = 'Take this offer off sale';
export const WITHDRAW_LEDE =
  'New buyers will not find it. Buyers who already approved keep the price they saw.';
export const WITHDRAW_REASON_LABEL = 'Why are you withdrawing it?';
export const WITHDRAW_LABEL = 'Withdraw this offer';
export const WITHDRAWN_DONE = 'Withdrawn. New buyers will not find this offer.';

export const HISTORY_HEADING = 'Version history';
export function historyLine(h: {
  version: string;
  status: OfferStatus;
  /** True for a version a newer one has replaced (history is newest first, so every row after the first). */
  superseded?: boolean;
  when: string;
  prices: string[];
}): string {
  const tail = h.prices.length === 0 ? '' : ` ${h.prices.join(', ')}.`;
  return `Version ${h.version}. ${historyStatusText(h.status, h.superseded !== true)}.${tail} ${h.when}`.trimEnd();
}

export function offerErrorText(code: string): string {
  switch (code) {
    case 'conflict':
      return 'This offer changed since you opened it. Reload the page and try again.';
    case 'invalid_price':
      return 'Enter each price with at most two decimals, from the lowest to the highest price shown.';
    case 'invalid_options':
      return 'Offer at least one option, and each option once.';
    case 'attestation_required':
      return 'Tick the box to confirm before you save.';
    case 'invalid_reason':
      return 'Give a reason of 3 to 200 characters.';
    case 'withdrawn':
      return 'This offer is withdrawn and cannot be changed.';
    case 'not_live':
      return 'Only an offer on sale can be changed.';
    case 'publisher_not_active':
      return 'Your account is not active, so offers cannot be changed. Contact the operator.';
    case 'not_found':
      return 'We could not find that offer.';
    case 'forbidden':
      return 'This account cannot do that.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/**
 * A typed price in major units to minor units: digits, optionally a point and one or two decimals.
 * Anything else (a comma, a sign, letters, a third decimal, other digit scripts) is null. Surrounding
 * spaces are ignored.
 */
export function parsePriceMinor(text: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (m === null) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
}

/** Minor units as the text an input shows: 250 gives 2.50. */
export const priceInputValue = (minor: number): string =>
  `${String(Math.trunc(minor / 100))}.${String(minor % 100).padStart(2, '0')}`;
