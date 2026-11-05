// The words of the publisher terms record (AGREE-1): the publisher home (S1) and the operator publishers
// page (S7). Pure: no server module, no clock. The record is a seeded demo record, never a click, and the
// sentences say so. Wording rules: D-051, no italics, no dashes. The golden test pins every string.

export const LINK_PUBLISHER_TERMS = 'Read the publisher terms';
export const NOT_ACCEPTED_TEXT = 'Publisher terms: not accepted.';

/** The demo label stored as accepted_by_label by the boot seed. It names no person. */
export const AGREEMENT_SEED_LABEL = 'Demo publisher contact';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A stored UTC instant as a day, month name and year, without a clock or a locale. */
export function dayText(isoUtc: string): string {
  const y = isoUtc.slice(0, 4);
  const m = Number(isoUtc.slice(5, 7));
  const d = Number(isoUtc.slice(8, 10));
  return `${String(d)} ${MONTHS[m - 1] ?? ''} ${y}`;
}

export function agreementText(a: {
  accepted_at: string;
  terms_version: string;
  method?: 'seeded_demo' | 'publisher_accepted';
}): string {
  // POB-P1: a click through record is the publisher's own act, not a demo record.
  if (a.method === 'publisher_accepted')
    return `Publisher terms: accepted on ${dayText(a.accepted_at)} (version ${a.terms_version}).`;
  return `Publisher terms: accepted on ${dayText(a.accepted_at)} (version ${a.terms_version}), demo record.`;
}

export const agreementChangedText = (current: string): string =>
  `Terms version changed, not re-accepted. The current version is ${current}.`;

export const acceptedByText = (label: string): string => `Recorded for ${label}.`;
