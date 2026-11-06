// INT-OPS-C / OPS-C.1 and OPS-C.2: the words and the masking rule of the operator buyer and seller pages. Pure:
// no server module, no clock. Without the second factor an id that names a key or a PayPal object shows as "…"
// and its last four characters (C2); the buyer page shows nothing but the notice.

/** What the buyer page says to a session without the authenticator code. */
export const OPS_MFA_NOTICE =
  'This page needs your authenticator code, because it names a buyer. Sign out and sign in again as a named operator with the code to see it.';

/** "…" and the last four characters, or null for no id. */
export function maskId(id: string | null): string | null {
  if (id === null) return null;
  return `…${id.slice(-4)}`;
}

/** The id as it may show: whole with the second factor, the last four without. */
export const shownId = (id: string | null, mfa: boolean): string | null => (mfa ? id : maskId(id));

export interface EntityFact {
  label: string;
  value: string;
}

/** The facts line of the seller page: payee and agreement, in words. */
export function sellerFacts(s: {
  payee: { verified: boolean; merchant: string | null };
  agreement: { terms_version: string; accepted_at: string } | null;
  offers: number;
  sales: number;
}): EntityFact[] {
  return [
    {
      label: 'Payee',
      value: s.payee.verified
        ? `Verified${s.payee.merchant === null ? '' : ` (${s.payee.merchant})`}`
        : s.payee.merchant === null
          ? 'No payee account yet'
          : `Not verified yet (${s.payee.merchant})`,
    },
    {
      label: 'Agreement',
      value:
        s.agreement === null ? 'No agreement accepted' : `Version ${s.agreement.terms_version}`,
    },
    { label: 'Offers', value: String(s.offers) },
    { label: 'Sales listed', value: String(s.sales) },
  ];
}

export interface PageSection {
  id: string;
  label: string;
}

/** The jump links of the buyer page, in page order. */
export const OPS_BUYER_PAGE_SECTIONS: PageSection[] = [
  { id: 'buyer-orders', label: 'Orders' },
  { id: 'buyer-refunds', label: 'Refunds' },
  { id: 'buyer-caps', label: 'Caps' },
  { id: 'buyer-keys', label: 'Keys' },
];

/** The jump links of the seller page, in page order. */
export const OPS_SELLER_PAGE_SECTIONS: PageSection[] = [
  { id: 'seller-offers', label: 'Offers' },
  { id: 'seller-sales', label: 'Sales' },
];

/** The facts line of the buyer page. */
export function buyerFacts(b: {
  country: string;
  created_at: string;
  library_count: number;
  orders: number;
}): EntityFact[] {
  return [
    { label: 'Country', value: b.country },
    { label: 'Signed up', value: b.created_at.slice(0, 10) },
    { label: 'Library', value: `${String(b.library_count)} items` },
    { label: 'Orders listed', value: String(b.orders) },
  ];
}
