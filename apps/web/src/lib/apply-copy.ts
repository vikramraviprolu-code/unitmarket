// The words of the public Apply to publish screens (PUB-APPLY), the two links to them and the two operator lines.
// Pure: no server module, no clock. The pages and the form take their sentences from here, and the golden test
// pins them. Wording rules: D-051, no italics, no dashes. The environment word is never typed here.

export const APPLY_TITLE = 'Apply to publish';
export const APPLY_LEDE =
  'Tell us who you are and what you publish. The owners read every application.';
export const APPLY_NO_ACCOUNT =
  'Applying creates no account. The operator reviews it. Nothing is paid or published until then.';

export const FIELD_NAME = 'Publisher name';
export const FIELD_COUNTRY = 'Country (two capital letters, for example GB)';
export const FIELD_NOTE = 'How to reach you and what you publish (3 to 200 characters)';
export const HINT_NAME =
  'Your publication or business name, 2 to 80 characters. No angle brackets.';
export const HINT_NOTE =
  'Give a website or a public profile where the owners can reach you, and say what you publish. Never include a password or payment details. Email addresses are not kept in a readable form, so a website or profile works best.';
export const HONEYPOT_LABEL = 'Leave this field empty';

export const SUBMIT_BUTTON = 'Send application';
export const SUBMIT_BUSY = 'Sending';

export const CONFIRM_TITLE = 'Application received';
export const CONFIRM_BODY = 'Keep this reference. It is the only way to check your application.';
export const CONFIRM_REFERENCE_LABEL = 'Your reference';
export const CONFIRM_NEXT =
  'The operator will review it. You cannot sign in until the owners have set that up for you.';
export const CONFIRM_LINK = 'Check the status of this application';

export const STATUS_TITLE = 'Application status';
export const STATUS_LEDE = 'Enter the reference you were given when you applied.';
export const STATUS_FIELD = 'Reference';
export const STATUS_BUTTON = 'Check status';
export const STATUS_NO_REF = 'Enter your reference to see where your application stands.';
export const STATUS_BACK = 'Back to the application form';

export type ApplyState = 'pending' | 'approved' | 'rejected' | 'unknown';
export type ApplyTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export function statusText(state: ApplyState): string {
  switch (state) {
    case 'pending':
      return 'Waiting for review';
    case 'approved':
      return 'Approved: the owners will contact you to set up sign in';
    case 'rejected':
      return 'Not approved';
    case 'unknown':
      return 'We do not have that reference';
  }
}

/** The chip tone of a state. The words always come with it, so colour is never alone. */
export function statusTone(state: ApplyState): ApplyTone {
  switch (state) {
    case 'pending':
      return 'info';
    case 'approved':
      return 'good';
    case 'rejected':
      return 'bad';
    case 'unknown':
      return 'neutral';
  }
}

export function applyErrorText(code: string): string {
  switch (code) {
    case 'invalid_input':
      return 'Please check the name (2 to 80 characters, no angle brackets), the country (two capital letters) and the note (3 to 200 characters, on one line).';
    case 'busy':
      return 'We cannot take new applications right now. Please try again later.';
    case 'rate_limited':
      return 'Too many applications from this connection. Please try again later.';
    case 'csrf':
      return 'That request was refused. Reload the page and try again.';
    case 'too_large':
      return 'That is too long. Please shorten the note.';
    default:
      return 'The application could not be sent. Please try again.';
  }
}

export const LINK_APPLY = 'Apply to publish';
export const SIGNIN_APPLY_LEAD = 'Want to publish your articles here?';
export const TERMS_APPLY_LEAD = 'Want to publish with us?';

export const OPS_NOTE_LABEL = 'Note on file';
export const OPS_SOURCE_PUBLIC = 'Applied on the public form';
export const OPS_SOURCE_OPERATOR = 'Added by an operator';
