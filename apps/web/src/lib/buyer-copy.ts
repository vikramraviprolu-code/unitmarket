// Buyer-facing wording for the search, results and library screens. Pure; kept out of the .tsx files so
// unit tests can pin it (the unit runner does not compile .tsx). Wording rules: D-051.
import type { FitDimension } from '@umsbx/contracts';
import { OPTION_LABEL } from './format';

// U3: the terms, shown where the buyer accepts them. The first line is the offer page's sentence and the
// second and third restate the approval page's, so the three screens say the same thing.
export const TERMS_SUMMARY = 'What the terms say';
export const TERMS_POINTS = [
  'Personal use only. No redistribution.',
  'Five days of access, starting when payment is confirmed.',
  'Once you start to buy, the price and these terms are held for 15 minutes.',
] as const;

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
