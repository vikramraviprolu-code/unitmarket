// The words the payee page (S6, "Where you get paid") and the operator payee page show (PUB-A2). Pure:
// no server module, no clock. The pages and the form components take their sentences from here, and
// the golden test pins them. Wording rules: D-051, no italics, no dashes. The environment word is
// never typed here: callers pass it in, taken from the stored environment.

export const PAYEE_HEADING = 'Where you get paid';
export const PAYEE_LEDE =
  'This page shows the payee account on file for you and what happens to your sales money. You cannot change it yourself. You can ask for a change, and an operator checks it before anything happens.';
export const LABEL_ACCOUNT = 'Account';
export const LABEL_VERIFIED = 'Verified';
export const LABEL_VERIFIED_BY = 'How it was checked';
export const LABEL_SETTLEMENT = 'Settlement';
export const VERIFIED_BY = 'An operator checked it. Not PayPal onboarding.';
// GATE35 D5: the legal pages say payee details are marked as checked when the demo data is loaded.
export const MARKED_CHECKED =
  'Marked as checked when the demo data was loaded. Not PayPal onboarding.';

/** An operator's decision on a request is an operator check; otherwise the account was marked at load. */
export const verifiedByText = (operatorDecided: boolean): string =>
  operatorDecided ? VERIFIED_BY : MARKED_CHECKED;

/** Only the last 4 characters of the account id are ever shown. */
export const accountText = (last4: string | null): string =>
  last4 === null ? 'No payee account is set yet.' : `Account on file ending ${last4}.`;

export const verifiedAtText = (when: string | null): string =>
  when === null ? 'Not verified yet.' : `Verified on ${when}.`;

export const OWNER_ONLY_NOTE = 'Payee changes on the hosted app are made by the owner.';

export const REQUEST_HEADING = 'Ask for a change';
export const REQUEST_LEDE =
  'Type the new merchant id. An operator confirms it with you before anything changes.';
export const FIELD_MERCHANT = 'New merchant id';
export const FIELD_MERCHANT_HINT = '13 capital letters and digits.';
export const FIELD_NOTE = 'Why are you changing it?';
export const REQUEST_SUBMIT = 'Send the request';
export const REQUEST_SENT = 'Request sent. Nothing changes until an operator verifies it.';

export const HISTORY_HEADING = 'Your requests';
export const HISTORY_EMPTY = 'You have not asked for a change yet.';

export type RequestState = 'open' | 'verified' | 'rejected';
export function requestStateText(s: RequestState): string {
  switch (s) {
    case 'open':
      return 'Open';
    case 'verified':
      return 'Verified';
    case 'rejected':
      return 'Rejected';
  }
}

export const historyLine = (h: { requested_last4: string; state: RequestState }): string =>
  `Account ending ${h.requested_last4}. ${requestStateText(h.state)}.`;

/** The publisher's request form: an answer code from the route in words. */
export function requestErrorText(code: string): string {
  switch (code) {
    case 'invalid_merchant_id':
      return 'A merchant id is 13 capital letters and digits.';
    case 'same_as_current':
      return 'That is already your payee account.';
    case 'invalid_input':
      return 'Please say why in 1 to 200 characters.';
    case 'rate_limited':
      return 'You can send 3 requests a day. Please try again tomorrow.';
    case 'forbidden':
      return 'This account cannot do that.';
    default:
      return 'The request could not be sent. Please try again.';
  }
}

export const OPS_HEADING = 'Payee requests';
export const OPS_LEDE =
  'Verify a request only after you have confirmed the new merchant id with the publisher. Type the whole id again to confirm it.';
export const OPS_MFA_HEADING = 'Operator actions need the authenticator code';
export const OPS_MFA_BODY =
  'Sign in again as an operator and enter the code from your authenticator app to see this queue. In the offline demo from the README there is no code, so this queue is not available.';
export const OPS_MFA_LINK = 'Sign in with the code';
export const OPS_EMPTY = 'No open requests.';
export const OPS_COL_PUBLISHER = 'Publisher';
export const OPS_COL_REQUESTED = 'Requested account';
export const OPS_COL_AGE = 'Age';
export const OPS_FIELD_RETYPE = 'Type the full merchant id again';
export const OPS_FIELD_REASON = 'Reason';
export const OPS_VERIFY = 'Verify';
export const OPS_REJECT = 'Reject';
export const OPS_DONE_VERIFIED = 'Verified. Future orders pay the new account.';
export const OPS_DONE_REJECTED = 'Rejected. Nothing changed.';

/** How long a request has waited, in words: less than a minute, minutes, hours or days (rounded down). */
export function ageText(ms: number): string {
  const unit = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  if (ms < 60_000) return 'less than a minute';
  if (ms < 3_600_000) return unit(Math.floor(ms / 60_000), 'minute');
  if (ms < 86_400_000) return unit(Math.floor(ms / 3_600_000), 'hour');
  return unit(Math.floor(ms / 86_400_000), 'day');
}

export function opsErrorText(code: string): string {
  switch (code) {
    case 'owner_command_required':
      return OWNER_ONLY_NOTE;
    case 'id_mismatch':
      return 'The id you typed is not the id that was requested. Nothing changed.';
    case 'already_decided':
      return 'This request was already decided.';
    case 'merchant_in_use':
      return 'That merchant id is held by another publisher. Nothing changed.';
    case 'not_found':
      return 'That request was not found.';
    case 'mfa_required':
      return 'Payee decisions need a sign in with your authenticator code.';
    case 'invalid_input':
      return 'Please type the full id again and give a reason of 3 to 200 characters.';
    case 'rate_limited':
      return 'Too many decisions this hour. Please try again later.';
    default:
      return 'The decision could not be saved. Please try again.';
  }
}
