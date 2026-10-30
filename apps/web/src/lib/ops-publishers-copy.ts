// The words the operator's publishers page (S7) and the two operator links show (PUB-D). Pure: no server
// module, no clock. The page, its form and /ops take their sentences from here, and the golden test pins
// them. Wording rules: D-051, no italics, no dashes. The environment word is never typed here: it
// comes from the stored environment. Payee accounts are named by their last 4 only.

export const OPS_LINK_PUBLISHERS = 'Publishers';
export const OPS_LINK_PAYEE_REQUESTS = 'Payee requests';

export const PUBLISHERS_HEADING = 'Publishers';
export const PUBLISHERS_LEDE =
  'What each publisher has on sale, what has been paid to them and what is still open. Suspending a publisher takes its offers off sale. Orders already paid, access already bought and refunds are not changed.';
// An operator signed in without the authenticator code: the page says why instead of sending them away.
export const PUBLISHERS_MFA_HEADING = 'This page needs your authenticator code';
export const PUBLISHERS_MFA_BODY =
  'This page needs your authenticator code. Sign out and sign in as Operator again with your name and the current code from your authenticator app.';
export const PUBLISHERS_MFA_LINK = 'Sign in with the code';
export const PUBLISHERS_EMPTY = 'No publishers yet.';
export const PUBLISHERS_BACK_LINK = 'Back to operations';

export const LABEL_STATUS = 'Status';
export const LABEL_PAYEE = 'Payee account on file';
export const LABEL_SETTLEMENT = 'Settlement';
export const LABEL_OFFERS = 'Offers on sale';
export const LABEL_MONEY = 'Money by currency';

export type PublisherStatus = 'applied' | 'active' | 'suspended';

export function statusText(status: PublisherStatus): string {
  switch (status) {
    case 'applied':
      return 'Applied. Waiting for approval.';
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
  }
}

/** The payee in words: the last 4 characters only, and only from stored data. */
export function payeeText(p: { last4: string | null; verified: boolean; shared: boolean }): string {
  if (p.last4 === null) return 'No payee account set.';
  if (!p.verified) return `Account on file ending ${p.last4}. Not checked yet.`;
  const base = `Account on file ending ${p.last4}. Marked as checked.`;
  return p.shared ? `${base} Shared with other test publishers.` : base;
}

export function offersText(n: number): string {
  if (n === 0) return 'No offers on sale.';
  if (n === 1) return '1 offer on sale.';
  return `${String(n)} offers on sale.`;
}

export const NO_PAYMENTS = 'No payments yet.';
export const COL_CURRENCY = 'Currency';
export const COL_CAPTURED = 'Units paid';
export const COL_NOT_REFUNDED = 'Paid and not refunded';
export const COL_REFUNDS_OPEN = 'Refunds open';
export const COL_HELD = 'On hold';
export const NONE_CELL = 'None';

/** A count and its amount, the amount already formatted by the page. */
export const countAmountText = (count: number, amount: string): string =>
  `${String(count)}, ${amount}`;

export const unitsText = (n: number): string => `${String(n)} unit${n === 1 ? '' : 's'}`;

export const SUSPEND_BUTTON = 'Suspend this publisher';
export const REACTIVATE_BUTTON = 'Reactivate this publisher';
export const SUSPEND_HINT =
  'Its offers go off sale at once and quotes already given stop working. Orders, access and refunds are not changed.';
export const REACTIVATE_HINT = 'Its offers go back on sale. Buyers need a new quote.';
export const APPLIED_HINT =
  'This account has not been approved yet, so there is nothing to suspend here.';
export const FIELD_REASON = 'Reason';
export const DONE_SUSPENDED = 'Suspended. The offers are off sale.';
export const DONE_REACTIVATED = 'Reactivated. The offers are back on sale.';

export function statusErrorText(code: string): string {
  switch (code) {
    case 'unchanged':
      return 'The publisher already has that status. Nothing changed.';
    case 'not_allowed':
      return 'This publisher has not been approved yet. Nothing changed.';
    case 'not_found':
      return 'That publisher was not found.';
    case 'mfa_required':
      return 'Changing a publisher needs a sign in with your authenticator code.';
    case 'invalid_input':
      return 'Please give a reason of 3 to 200 characters.';
    case 'rate_limited':
      return 'Too many changes this hour. Please try again later.';
    default:
      return 'The change could not be saved. Please try again.';
  }
}
