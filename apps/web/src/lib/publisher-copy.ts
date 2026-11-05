// The words the publisher shell and the publisher sign-in choices show (PUB-A1). Pure: no server
// module, no clock. The sign-in form, the layout and the publisher page take their sentences from
// here, and the golden test pins them. Wording rules: D-051, no italics, no dashes. The environment
// word (Sandbox or Dry run) is never typed here: it comes from the stored environment.

export type PublisherStatus = 'applied' | 'active' | 'suspended';

/** The publisher personas: the sign-in id, the publisher row it maps to (by slug) and its label. */
export const PUBLISHER_PERSONAS = [
  { id: 'publisher-harbour-ledger', slug: 'harbour-ledger', label: 'Harbour Ledger (seller)' },
  {
    id: 'publisher-quayside-gazette',
    slug: 'quayside-gazette',
    label: 'Quayside Gazette (seller)',
  },
  {
    id: 'publisher-northfield-quarterly',
    slug: 'northfield-quarterly',
    label: 'Northfield Quarterly (seller)',
  },
] as const;

export type PublisherPersonaId = (typeof PUBLISHER_PERSONAS)[number]['id'];

export const isPublisherPersona = (id: string): id is PublisherPersonaId =>
  PUBLISHER_PERSONAS.some((p) => p.id === id);

/** The publisher slug a publisher persona signs in as, or undefined for any other persona. */
export const publisherSlugOf = (id: string): string | undefined =>
  PUBLISHER_PERSONAS.find((p) => p.id === id)?.slug;

/** Every sign-in choice, in the order shown. */
export const SIGNIN_PERSONAS: readonly { id: string; label: string }[] = [
  { id: 'buyer-a', label: 'Buyer A' },
  { id: 'buyer-b', label: 'Buyer B' },
  ...PUBLISHER_PERSONAS.map((p) => ({ id: p.id, label: p.label })),
  { id: 'operator', label: 'Operator' },
];

export const DEMO_PASSCODE_LABEL = 'Demo passcode';
export const DEMO_PASSCODE_HINT = 'The passcode your team lead gave you. You can paste it.';
export const PUBLISHER_PASSCODE_LABEL = 'Publisher passcode';
export const PUBLISHER_PASSCODE_HINT =
  'The publisher passcode your team lead gave you. The demo passcode does not work for publishers.';

// INT-UI0 owns this rename in the nav and the tabs (decision V2); SEL renames the page copy.
export const PUBLISHER_NAV_LABEL = 'Seller';
export const PUBLISHER_HEADING = 'Seller home';
export const PUBLISHER_LEDE = 'This page shows your own seller account. It is read only.';
export const LABEL_NAME = 'Name';
export const LABEL_STATUS = 'Status';
export const LABEL_OFFERS = 'Offers live';
export const LABEL_PAYEE = 'Payee account on file';
export const LABEL_SETTLEMENT = 'Settlement';

export function publisherStatusText(status: PublisherStatus): string {
  switch (status) {
    case 'applied':
      return 'Applied. Waiting for approval.';
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
  }
}

export const APPLIED_NOTICE = 'This account is waiting for approval.';
export const SUSPENDED_NOTICE = 'This account is suspended. Contact the operator.';

export function offersLiveText(n: number): string {
  if (n === 0) return 'No offers are live.';
  if (n === 1) return '1 offer is live.';
  return `${String(n)} offers are live.`;
}

export const NO_OFFERS_TITLE = 'No live offers yet';
export const NO_OFFERS_BODY = 'When you have an offer on sale, it is counted here.';

/** The links on the publisher home page: the pages a publisher can reach from here. */
export const LINK_OFFERS = 'Your offers';
export const LINK_SALES = 'Sales';
export const LINK_STATEMENT = 'Statement';
export const LINK_PAYOUT_ACCOUNT = 'Where you get paid';

/** The payee in words: only the last 4 characters of the account id, and only from stored data. */
export function payeeText(p: { last4: string | null; verified_at: string | null }): string {
  if (p.last4 === null) return 'No payee account is set yet.';
  if (p.verified_at === null) return `Waiting for a check. Account on file ending ${p.last4}.`;
  return `Marked as checked. Account on file ending ${p.last4}.`;
}
