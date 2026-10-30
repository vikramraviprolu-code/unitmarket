// The view model of the operator publishers and payee request screens (PUB-UI-OPS). Pure: no server module,
// no clock. It turns stored values into a chip tone and its words, and counts the summary figures from
// stored rows. Wording rules: D-051, no italics, no dashes. The environment word is never typed here.
// The sentences the pages already show stay in ops-publishers-copy.ts, ops-applicants-copy.ts, payee-copy.ts
// and agreement-copy.ts; only the new short words of the redesign are here.

export type ChipTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export interface ChipView {
  tone: ChipTone;
  text: string;
}

export const OPS_CARD_EVALS_TEXT =
  'How the model is checked, and how the baseline does on the cases.';
export const OPS_CARD_PUBLISHERS_TEXT =
  'Status, payee account, money and terms for each one, and who has applied.';
export const OPS_CARD_PAYEE_TEXT = 'Account changes waiting for a decision.';

export const TILE_ACTIVE = 'Active publishers';
export const TILE_SUSPENDED = 'Suspended';
export const TILE_APPLICANTS = 'Applicants waiting';
export const TILE_OFFERS = 'Offers on sale';
export const TILE_OPEN_REQUESTS = 'Open requests';
export const TILE_OLDEST = 'Oldest waiting';
export const TILE_NONE = 'None';

export const STATUS_DETAILS_SUMMARY = 'Change status';
export const REQUEST_STATE_OPEN = 'Open';

export type PublisherStatusValue = 'applied' | 'active' | 'suspended';

export function publisherStatusTone(status: PublisherStatusValue): ChipTone {
  switch (status) {
    case 'active':
      return 'good';
    case 'suspended':
      return 'bad';
    case 'applied':
      return 'info';
  }
}

/** The payee account state as a chip. The sentence with the last 4 stays in payeeText. */
export function payeeChip(p: {
  last4: string | null;
  verified: boolean;
  shared: boolean;
}): ChipView {
  if (p.last4 === null) return { tone: 'neutral', text: 'No payee account' };
  if (!p.verified) return { tone: 'warn', text: 'Payee not checked' };
  return { tone: 'good', text: 'Payee checked' };
}

/** The publisher terms record as a chip: accepted at the current version, version changed, or not accepted. */
export function agreementChip(
  agreement: { terms_version: string } | null,
  currentVersion: string,
): ChipView {
  if (agreement === null) return { tone: 'neutral', text: 'Terms not accepted' };
  if (agreement.terms_version !== currentVersion)
    return { tone: 'warn', text: 'Terms version changed' };
  return { tone: 'good', text: `Terms ${agreement.terms_version} accepted` };
}

export function applicantStateChip(state: 'pending' | 'rejected'): ChipView {
  return state === 'pending'
    ? { tone: 'warn', text: 'Waiting for your answer' }
    : { tone: 'bad', text: 'Rejected' };
}

export const reasonGivenText = (reason: string): string => `Reason given: ${reason}`;

export interface PublisherTiles {
  active: number;
  suspended: number;
  applicantsWaiting: number;
  offersOnSale: number;
}

/** Counts from the stored rows the page already read. An applied row has no offers on sale and is not counted. */
export function publisherTiles(
  publishers: ReadonlyArray<{ status: PublisherStatusValue; offers_live: number }>,
  applicants: ReadonlyArray<{ state: 'pending' | 'rejected' }>,
): PublisherTiles {
  return {
    active: publishers.filter((p) => p.status === 'active').length,
    suspended: publishers.filter((p) => p.status === 'suspended').length,
    applicantsWaiting: applicants.filter((a) => a.state === 'pending').length,
    offersOnSale: publishers.reduce((sum, p) => sum + p.offers_live, 0),
  };
}

export function oldestAgeMs(requests: ReadonlyArray<{ age_ms: number }>): number | null {
  if (requests.length === 0) return null;
  return requests.reduce((max, r) => (r.age_ms > max ? r.age_ms : max), 0);
}
