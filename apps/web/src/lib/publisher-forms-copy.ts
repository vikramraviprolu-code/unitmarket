// The words and view-model rules of the three publisher forms: create an offer, change or withdraw an
// offer, and ask for a payee change (PUB-UI-FORMS). Pure: no server module, no clock. The pinned offer and
// payee sentences stay in offer-copy.ts, publisher-e1-copy.ts and payee-copy.ts; this file adds only the
// section headings, the help lines and the mapping from a status or an answer code to a chip or a field.
// Wording rules: D-051, no italics, no dashes. The environment word is never typed here.
import type { OfferStatus } from './offer-copy';

export type PillTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export const BACK_TO_PUBLISHER_HOME = 'Back to seller home';

// Offer form sections
export const SECTION_WHAT = 'What you are selling';
export const SECTION_PRICES = 'Prices and options';
export const SECTION_LICENCE = 'Licence and AI use';
export const SECTION_REVIEW = 'Review and save';

export const HELP_ARTICLE = 'Only articles of yours that have no offer on sale are listed.';
export const HELP_LICENCE = 'The licence, the terms and the access window are set by UnitMarket.';
export const HELP_ATTEST_SAVE = 'You confirm this each time you save a new version.';
export const HELP_ATTEST_CREATE = 'You confirm this before the offer goes on sale.';
export const HELP_SAVE = 'Saving makes a new version of the offer.';

/** What the buyer gets with one option, in one line under its checkbox. */
export function optionHelp(option: string): string {
  switch (option) {
    case 'keep_retrieve':
      return 'The buyer downloads the article and keeps a copy.';
    case 'online_read':
      return 'The buyer reads the article online during the access window.';
    default:
      return '';
  }
}

/** The allowed range from priceHint, plus how to type it. */
export const priceHelp = (range: string): string => `${range} Type it like 2.50.`;

// What a buyer sees (the revise page)
export const BUYER_SEES_HEADING = 'What a buyer sees';
export const BUYER_SEES_NOTE =
  'This is the saved version. What you type below shows here after you save.';
export const BUYER_SEES_OFF = 'Buyers see this offer as not on sale.';
// The same page for an offer that is withdrawn or still a draft: it only shows what is saved.
export const OFFER_READONLY_LEDE = 'This page shows the saved offer. Nothing on it can be changed.';
export const BUYER_SEES_NOTE_READONLY = 'This is the saved version.';

// Withdraw
export const WITHDRAW_HELP = 'Give a short reason, 3 to 200 characters.';

// Payee page
export const PAYEE_SECTION_CURRENT = 'Payee on file';
export const PAYEE_SECTION_SETTLEMENT = 'Where your sales money goes';
export const PAYEE_NONE_TEXT = 'No payee account is set';
export const FIELD_NOTE_HINT = 'A few words, up to 200 characters.';

/** One status as the word and the tone of its chip. Colour never stands alone: the chip carries the word. */
export function offerStatusTone(s: OfferStatus): PillTone {
  switch (s) {
    case 'authorised':
      return 'good';
    case 'draft':
      return 'warn';
    case 'withdrawn':
      return 'neutral';
  }
}

export type OfferField = 'price' | 'options' | 'attest' | 'reason' | 'form';

/** Where an answer code from the offer routes is shown: beside its field, or for the whole form. */
export function offerErrorField(code: string): OfferField {
  switch (code) {
    case 'invalid_price':
      return 'price';
    case 'invalid_options':
      return 'options';
    case 'attestation_required':
      return 'attest';
    case 'invalid_reason':
      return 'reason';
    default:
      return 'form';
  }
}

export type PayeeField = 'merchant' | 'note' | 'form';

/** Where an answer code from the payee request route is shown. */
export function payeeErrorField(code: string): PayeeField {
  switch (code) {
    case 'invalid_merchant_id':
    case 'same_as_current':
      return 'merchant';
    case 'invalid_input':
      return 'note';
    default:
      return 'form';
  }
}

/** The chip for the payee on file: none is a warning, unverified is pending, verified is good. */
export function payeeChip(p: {
  last4: string | null;
  verifiedAt: string | null;
  operatorChecked: boolean;
}): { tone: PillTone; text: string } {
  if (p.last4 === null) return { tone: 'warn', text: 'None' };
  if (p.verifiedAt === null) return { tone: 'info', text: 'Pending' };
  return {
    tone: 'good',
    text: p.operatorChecked ? 'Checked by an operator' : 'Marked as checked',
  };
}

/** Only the last 4 characters of the account id are ever shown. */
export const payeeEndingText = (last4: string | null): string =>
  last4 === null ? PAYEE_NONE_TEXT : `ending ${last4}`;

export interface OptionInput {
  option: string;
  offered: boolean;
  price: string;
}

export interface CollectedOptions {
  options: { option: string; price_minor: number }[];
  /** The offered options whose typed price is not a price in range. */
  bad: string[];
  /** The answer code the form shows before it sends anything, or null when the body can be sent. */
  code: 'invalid_price' | 'invalid_options' | null;
}

/**
 * The options to send, from what was typed. A price is valid when parsePriceMinor reads it and it lies from
 * 1 to the cap in minor units. The route and the domain check everything again; this only spares a round trip.
 */
export function collectOptions(
  rows: readonly OptionInput[],
  capMinor: number,
  parse: (text: string) => number | null,
): CollectedOptions {
  const options: { option: string; price_minor: number }[] = [];
  const bad: string[] = [];
  for (const r of rows) {
    if (!r.offered) continue;
    const minor = parse(r.price);
    if (minor === null || minor < 1 || minor > capMinor) bad.push(r.option);
    else options.push({ option: r.option, price_minor: minor });
  }
  if (bad.length > 0) return { options: [], bad, code: 'invalid_price' };
  if (options.length === 0) return { options, bad, code: 'invalid_options' };
  return { options, bad, code: null };
}
