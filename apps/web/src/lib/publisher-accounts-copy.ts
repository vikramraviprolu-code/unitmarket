// The words of the publisher account screens (POB-P1): claim an account with an invite code, sign in with a
// username and password, accept the publisher terms, link your own PayPal address, and the operator's sign in
// access section. Pure: no server module, no clock. The pages and forms take their sentences from here, and the
// golden test pins them. Wording rules: D-051, no italics, no dashes. The environment word is never typed here.
import { dayText } from './agreement-copy';
import { passwordReasonText } from './account-copy';

// ---- Claim (/signin/seller/claim) ---------------------------------------------------------------------
export const CLAIM_TITLE = 'Claim your publisher account';
export const CLAIM_LEDE =
  'An operator gives you a one time invite code when your application is approved. Enter it here, then choose a username and a password. The code works once and expires after 7 days.';
export const CLAIM_FIELD_CODE = 'Invite code';
export const CLAIM_HINT_CODE = '12 letters and digits. Capital or small letters both work.';
export const CLAIM_FIELD_USERNAME = 'Username';
export const CLAIM_HINT_USERNAME =
  '3 to 30 small letters, digits, dots, underscores or hyphens. No email address is asked for or sent.';
export const CLAIM_FIELD_PASSWORD = 'Password';
export const CLAIM_HINT_PASSWORD =
  '12 to 128 characters. A phrase only you know works well. If you lose it, an operator resets it by hand.';
export const CLAIM_SUBMIT = 'Claim account';
export const CLAIM_BUSY = 'Claiming';
export const CLAIM_ERROR_TITLE = 'Could not claim the account';
export const CLAIM_HAVE_ACCOUNT = 'Already claimed your account?';
export const CLAIM_SIGN_IN_LINK = 'Sign in';

export function claimErrorText(code: string, reason?: string): string {
  switch (code) {
    case 'invalid_code':
      return 'That invite code did not work. It may be mistyped, already used, replaced by a newer one, or expired. Ask an operator for a new one.';
    case 'taken':
      return 'That username is taken. Choose another.';
    case 'weak_password':
      return passwordReasonText(reason);
    case 'invalid_input':
      return 'Please check the form. The code is 12 letters and digits, and the username is 3 to 30 small letters, digits, dots, underscores or hyphens.';
    case 'rate_limited':
      return 'Too many tries from this connection. Please try again later.';
    case 'busy':
      return 'We cannot claim accounts right now. Please try again later.';
    case 'csrf':
      return 'That request was refused. Reload the page and try again.';
    default:
      return 'The account could not be claimed. Please try again.';
  }
}

// ---- Sign in with the account (/signin/seller) ----------------------------------------------------------
export const ACCOUNT_SIGNIN_HEADING = 'Sign in with your publisher account';
export const ACCOUNT_SIGNIN_LEDE =
  'Use the username and password you chose when you claimed your account.';
export const ACCOUNT_SIGNIN_USERNAME = 'Username';
export const ACCOUNT_SIGNIN_PASSWORD = 'Password';
export const ACCOUNT_SIGNIN_SUBMIT = 'Sign in';
export const ACCOUNT_SIGNIN_BUSY = 'Signing in';
export const ACCOUNT_SIGNIN_FAILED = 'That username or password did not work.';
export const ACCOUNT_SIGNIN_CLAIM_LEAD = 'Have an invite code?';
export const ACCOUNT_SIGNIN_CLAIM_LINK = 'Claim your account';
export const DEMO_SIGNIN_HEADING = 'Test personas for judges and testers';

// ---- Terms (publisher home) -----------------------------------------------------------------------------
export const TERMS_ACCEPT_HEADING = 'Accept the publisher terms';
export const TERMS_ACCEPT_LEAD =
  'Accepting records that you read this version of the publisher terms. It is saved against your username.';
export const TERMS_ACCEPT_BUTTON = 'Accept the publisher terms';
export const TERMS_ACCEPT_BUSY = 'Saving';
export const TERMS_ACCEPT_DONE = 'Recorded. You accepted the publisher terms.';
export const TERMS_CHANGED_LEAD = 'The terms changed. Please read and accept the current version.';

/** The record of a click through acceptance, in words. */
export const termsAcceptedText = (a: {
  accepted_at: string;
  terms_version: string;
  accepted_by_label: string;
}): string =>
  `Accepted on ${dayText(a.accepted_at)} (version ${a.terms_version}) by ${a.accepted_by_label}.`;

export function termsErrorText(code: string): string {
  switch (code) {
    case 'no_account':
      return 'Only a publisher who claimed an account can accept the terms.';
    case 'already_accepted':
      return 'You already accepted this version.';
    case 'csrf':
      return 'That request was refused. Reload the page and try again.';
    default:
      return 'The acceptance could not be saved. Please try again.';
  }
}

// ---- PayPal link (payout page) --------------------------------------------------------------------------
export const LINK_HEADING = 'Your PayPal address';
export const LINK_LEDE =
  'UnitMarket pays out to the PayPal Business account you already have. UnitMarket never creates a PayPal account for you. Enter the email address of your own PayPal Business account. An operator checks it with you before it is used.';
/** Pinned: also the answer of the link route to a publisher with no claimed account. */
export const LINK_NO_ACCOUNT = 'Only a publisher who claimed an account can link an address.';
export const LINK_NONE = 'No PayPal address is linked yet.';
export const LINK_FIELD_EMAIL = 'PayPal email address';
export const LINK_HINT_EMAIL =
  'The email address of your own PayPal Business account. If you change it, it goes back to waiting for a check.';
export const LINK_SUBMIT = 'Send for checking';
export const LINK_SENT = 'Sent. Nothing is used until an operator has checked it with you.';
export const LINK_STATE_REQUESTED = 'Waiting for an operator to check it.';
export const LINK_STATE_VERIFIED = 'Checked by an operator.';
/** POB-DEMOLINK: the dry run seed's synthetic address. Chosen from the stored link, never typed by environment. */
export const LINK_STATE_SYNTHETIC = 'Demo address. Not a real PayPal account.';
export const linkStateText = (state: 'requested' | 'verified', synthetic = false): string =>
  state === 'verified'
    ? synthetic
      ? LINK_STATE_SYNTHETIC
      : LINK_STATE_VERIFIED
    : LINK_STATE_REQUESTED;
export const linkLine = (
  email: string,
  state: 'requested' | 'verified',
  synthetic = false,
): string => `${email}. ${linkStateText(state, synthetic)}`;

export function linkErrorText(code: string): string {
  switch (code) {
    case 'no_account':
      return LINK_NO_ACCOUNT;
    case 'invalid_email':
      return 'Please enter a valid email address, for example name@example.com.';
    case 'same_as_current':
      return 'That is already your checked PayPal address.';
    case 'rate_limited':
      return 'You can send 5 changes a day. Please try again tomorrow.';
    case 'forbidden':
      return 'This account cannot do that.';
    default:
      return 'The address could not be sent. Please try again.';
  }
}

// ---- Operator: sign in access (/ops/publishers) ---------------------------------------------------------
export const ACCESS_HEADING = 'Sign in access';
export const ACCESS_LEDE =
  'Active publishers claim their own account with a one time invite code. The code is shown once, on this screen, and is stored only as a hash.';
export const ACCESS_EMPTY = 'No publishers to show.';
export const ACCESS_DEMO_NOTE =
  'The three demo publishers sign in with their test personas and are not listed here.';
export const accessAccountText = (username: string | null): string =>
  username === null ? 'Account: not claimed yet.' : `Account: claimed by ${username}.`;
export const accessInviteText = (
  state: 'none' | 'live' | 'expired' | 'used',
  expiresAt: string | null,
): string => {
  switch (state) {
    case 'none':
      return 'Invite: none.';
    case 'live':
      return `Invite: waiting, valid until ${expiresAt === null ? 'its expiry' : dayText(expiresAt)}.`;
    case 'expired':
      return 'Invite: expired.';
    case 'used':
      return 'Invite: used.';
  }
};
export const accessTermsText = (a: { version: string; method: string } | null): string =>
  a === null
    ? 'Terms: not accepted.'
    : a.method === 'publisher_accepted'
      ? `Terms: accepted by the publisher (version ${a.version}).`
      : `Terms: demo record (version ${a.version}).`;
export const accessLinkText = (
  l: { state: 'requested' | 'verified'; masked_email: string; synthetic?: boolean } | null,
): string =>
  l === null
    ? 'PayPal address: none.'
    : `PayPal address: ${l.masked_email}. ${linkStateText(l.state, l.synthetic === true)}`;
export const ACCESS_ISSUE_BUTTON = 'Issue an invite code';
export const ACCESS_REPLACE_BUTTON = 'Replace the invite code';
export const ACCESS_RESET_BUTTON = 'Reset sign in';
export const ACCESS_ISSUE_HINT =
  'A new code voids the old one. The publisher claims the account with it.';
export const ACCESS_RESET_HINT =
  'Reset removes the password, ends every session of this publisher and issues a new invite code so they can claim the account again.';
export const accessReasonLabel = (name: string): string => `${name}: reason, 3 to 200 characters`;

export const INVITE_SHOWN_HEADING = 'Invite code';
export const INVITE_SHOWN_WARNING =
  'Copy this code now and give it to the publisher by a channel you trust. It is shown once and cannot be shown again.';
export const inviteExpiresText = (expiresAt: string): string =>
  `It works once and expires after ${dayText(expiresAt)}.`;
/** The code in groups of four so it is easy to read out. The form accepts it with or without the hyphens. */
export const inviteGroups = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1-');
export const INVITE_COPIED_BUTTON = 'I have copied the code';

export function accessErrorText(code: string): string {
  switch (code) {
    case 'has_account':
      return 'This publisher already has an account. Use reset sign in instead.';
    case 'no_account':
      return 'This publisher has no account yet. Issue an invite code instead.';
    case 'not_allowed':
      return 'That cannot be done for this publisher: it must be active, and the demo publishers use test personas. Nothing changed.';
    case 'not_found':
      return 'That publisher was not found.';
    case 'mfa_required':
      return 'Changing sign in access needs a sign in with your authenticator code.';
    case 'invalid_input':
      return 'Please give a reason of 3 to 200 characters.';
    case 'rate_limited':
      return 'Too many changes this hour. Please try again later.';
    default:
      return 'The change could not be saved. Please try again.';
  }
}

export const LINKS_HEADING = 'PayPal addresses to check';
export const LINKS_LEDE =
  'Confirm the address with the publisher first, then type it again in full. Only then is it marked as checked.';
export const LINKS_EMPTY = 'No addresses are waiting for a check.';
export const LINKS_FIELD_RETYPE = 'Type the full PayPal email address again';
export const LINKS_FIELD_REASON = 'Reason';
export const LINKS_VERIFY = 'Mark as checked';
export const LINKS_DONE = 'Marked as checked.';

export function linkDecisionErrorText(code: string): string {
  switch (code) {
    case 'email_mismatch':
      return 'The address you typed is not the address that was sent. Nothing changed.';
    case 'already_verified':
      return 'This address was already checked.';
    case 'not_found':
      return 'That publisher has no address waiting.';
    case 'mfa_required':
      return 'Checking an address needs a sign in with your authenticator code.';
    case 'invalid_input':
      return 'Please type the full address again and give a reason of 3 to 200 characters.';
    case 'rate_limited':
      return 'Too many decisions this hour. Please try again later.';
    default:
      return 'The decision could not be saved. Please try again.';
  }
}
