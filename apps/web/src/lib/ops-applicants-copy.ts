// The words the Applicants section of the operator's publishers page shows (PUB-E2). Pure: no server
// module, no clock. The page and its forms take their sentences from here, and the golden test pins them.
// Wording rules: D-051, no italics, no dashes. The environment word is never typed here.

export const APPLICANTS_HEADING = 'Applicants';
export const APPLICANTS_LEDE =
  'Publishers who applied on the public form, or whom an operator added. Applying creates no account. An approved publisher claims one with an invite code.';
export const APPLICANTS_NO_LOGIN =
  'Approving an applicant makes it an active publisher and shows you a one time invite code, once. Give the code to the publisher so they can claim their account and sign in. Until then it has no payee account and no offers.';
export const APPLICANTS_EMPTY = 'No applicants waiting.';

export const ADD_HEADING = 'Add an applicant';
export const FIELD_NAME = 'Display name';
export const FIELD_SLUG =
  'Short name (3 to 40 lowercase letters or numbers, single hyphens allowed between parts)';
export const FIELD_COUNTRY = 'Country (two capital letters, for example GB)';
export const FIELD_NOTE = 'Why you are adding them (3 to 200 characters)';
/** The name comes first, so the label reads cleanly even when the name has brackets of its own. */
export const decisionReasonLabel = (name: string): string =>
  `${name}: reason for your answer, 3 to 200 characters`;

export const ADD_BUTTON = 'Add applicant';
export const APPROVE_BUTTON = 'Approve';
export const REJECT_BUTTON = 'Reject';
export const APPROVE_HINT =
  'Approve makes the publisher active and shows an invite code once. The publisher claims their account with it.';
export const REJECT_HINT =
  'Reject keeps the record and the reason. It cannot be undone and the applicant stays unable to sign in or sell.';

export type ApplicantStateValue = 'pending' | 'rejected';
export function applicantStateText(state: ApplicantStateValue): string {
  switch (state) {
    case 'pending':
      return 'Waiting for your answer';
    case 'rejected':
      return 'Rejected';
  }
}
export const rejectedReasonText = (reason: string): string => `Rejected. Reason given: ${reason}`;
export const applicantLine = (a: { country: string; slug: string }): string =>
  `${a.country}, short name ${a.slug}`;

export const DONE_ADDED = 'Applicant added. It is waiting for your answer.';
export const DONE_APPROVED =
  'Approved. The publisher is active. Give them the invite code below so they can claim their account.';
export const DONE_REJECTED = 'Rejected. The record and your reason are kept.';

export function applicantErrorText(code: string): string {
  switch (code) {
    case 'invalid_slug':
      return 'The short name must be 3 to 40 lowercase letters or numbers, with single hyphens between parts.';
    case 'slug_taken':
      return 'That short name is already used. Nothing was saved.';
    case 'already_decided':
      return 'This applicant has already been answered. Nothing changed.';
    case 'not_allowed':
      return 'Only an applicant can be approved or rejected. Nothing changed.';
    case 'not_found':
      return 'That applicant was not found.';
    case 'mfa_required':
      return 'Changing applicants needs a sign in with your authenticator code.';
    case 'invalid_input':
      return 'Please check the name, the country (two capital letters) and the reason (3 to 200 characters).';
    case 'rate_limited':
      return 'Too many changes this hour. Please try again later.';
    default:
      return 'The change could not be saved. Please try again.';
  }
}
