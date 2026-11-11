// CAT-2.6: the words of the popular requests on /discover, the collection and copy lines on a proposal card, and
// the "What buyers ask for" card on the publisher home. Bands are shown as the domain gives them; no exact count,
// no buyer, no raw text. D-051: no italics, no dashes in the copy.
export const POPULAR_HEADING = 'Popular requests';
export const POPULAR_HINT =
  'Asked for by 5 or more buyers in the last 30 days. Tap one to fill the box.';
export const DEMAND_CARD_HEADING = 'What buyers ask for';
export const DEMAND_CARD_EMPTY = 'No requests from 5 or more buyers yet.';
export const DEMAND_CARD_NOTE =
  'Bands from buyers who asked in the last 30 days. No buyer is named.';

export const MAX_CHIPS = 10;
export const MAX_CARD_LINES = 5;

export type DemandBandText = '5-9' | '10-49' | '50+';

export const demandLine = (term: string, band: DemandBandText, matching: number): string =>
  `${term}: ${band} buyers asked; ${matching} of your offers match`;

// Photos only when the cover of the collection is an image; otherwise items.
export const collectionLine = (name: string, size: number, images: boolean): string => {
  const noun = images ? 'photo' : 'item';
  return `From the ${name} collection (${size} ${size === 1 ? noun : `${noun}s`})`;
};

export const copiesHiddenLine = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'} hidden`;

export interface PopularRequestsView {
  heading: string;
  hint: string;
  chips: { term: string; fill: string }[];
}

/** Null for no terms: the whole block, heading included, is then absent. */
export function popularRequestsView(
  terms: readonly { term: string; band: DemandBandText }[],
): PopularRequestsView | null {
  if (terms.length === 0) return null;
  return {
    heading: POPULAR_HEADING,
    hint: POPULAR_HINT,
    chips: terms.slice(0, MAX_CHIPS).map((t) => ({ term: t.term, fill: t.term })),
  };
}

export interface DemandCardView {
  heading: string;
  note: string;
  empty: string | null;
  lines: string[];
}

export function demandCardView(
  rows: readonly { term: string; band: DemandBandText; matching: number }[],
): DemandCardView {
  return {
    heading: DEMAND_CARD_HEADING,
    note: DEMAND_CARD_NOTE,
    empty: rows.length === 0 ? DEMAND_CARD_EMPTY : null,
    lines: rows.slice(0, MAX_CARD_LINES).map((r) => demandLine(r.term, r.band, r.matching)),
  };
}
