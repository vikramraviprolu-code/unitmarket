// The words of the landing page, the three role pages, the buyer account screens and the password help
// (ID-ACCOUNTS). Pure: no server module, no clock. The pages and forms take their sentences from here, and
// the golden test pins them. Wording rules: D-051, no italics, no dashes, no emoji. The environment word is
// never typed here: it comes from the stored environment. Short plain sentences.

import { DEFAULT_ACCESS_DAYS } from './format';

/** The contact address for a lost password. The same address the legal pages give. */
export const CONTACT_ADDRESS = 'unitmarket@raviprolu.com';
/** The version of the Terms and the Privacy notice a new account accepts (stored on the consent rows). */
export const ACCOUNT_CONSENT_VERSION = 'terms-v1';

// ---- Landing page (/) -------------------------------------------------------------------------------
export const DOORS_TITLE = 'Choose your door';
export const DOORS_LEDE =
  'UnitMarket has three kinds of visitor. Pick the one that sounds like you.';

export interface Door {
  id: 'buyer' | 'seller' | 'operator';
  label: string;
  tag: string;
  line: string;
  need: string;
  button: string;
  href: string;
  /** What the button says for someone who is already signed in as this role, and where it goes. */
  home_button: string;
  home_href: string;
}

export const DOORS: readonly Door[] = [
  {
    id: 'buyer',
    label: 'Buyer',
    tag: 'I want to read',
    line: `Find one article, see the price, pay once and read it for ${DEFAULT_ACCESS_DAYS} days.`,
    need: 'You need: a username and a password. No email.',
    button: 'Go to the buyer page',
    href: '/buyer',
    home_button: 'Go to your library',
    home_href: '/library',
  },
  {
    id: 'seller',
    label: 'Seller',
    tag: 'I want to publish',
    line: 'Sell single articles to readers who want just one. The owners review every application.',
    need: 'You need: a publisher name, a country and a public website or profile.',
    button: 'Go to the seller page',
    href: '/seller',
    home_button: 'Go to your publisher pages',
    home_href: '/publisher',
  },
  {
    id: 'operator',
    label: 'Operator',
    tag: 'I run the platform',
    line: 'Review applications, watch payments and stop PayPal calls.',
    need: 'You need: your passcode, your operator name and the code from your authenticator app.',
    button: 'Go to operator sign in',
    href: '/signin/operator',
    home_button: 'Go to operations',
    home_href: '/ops',
  },
];

export const SIGNED_IN_HERE = 'You are signed in here.';
export const JUDGES_LEAD = 'Judges and testers sign in with a test persona.';
export const JUDGES_LINK = 'Open the test sign in';

// ---- Buyer page (/buyer) ----------------------------------------------------------------------------
export const BUYER_TITLE = 'Buy articles one at a time';
export const BUYER_LEDE =
  'Make a free account once. Come back any day with the same username and password.';
export const BUYER_NEED_TITLE = 'What you need';
export const BUYER_NEED_ITEMS: readonly string[] = [
  'A display name, 2 to 60 characters. This is how we greet you.',
  'A username, 3 to 30 characters: letters, digits, dot, dash or underscore. You use it to sign in.',
  'A password of 12 or more characters. A phrase of four words is a good one. You can paste it.',
  'Your country, as two capital letters, for example GB or US.',
];
export const BUYER_NO_EMAIL = 'We do not ask for an email address and we send you no email.';
export const BUYER_LOST_TITLE = 'If you lose your password';
export const BUYER_LOST = `The operator resets it by hand. Write to ${CONTACT_ADDRESS} and give your username.`;
export const BUYER_CREATE = 'Create account';
export const BUYER_SIGN_IN = 'Sign in';

// ---- Create account (/signup) ------------------------------------------------------------------------
export const SIGNUP_TITLE = 'Create your account';
export const SIGNUP_LEDE = 'It takes one minute. No email is asked for or sent.';
export const SIGNUP_FIELD_NAME = 'Display name';
export const SIGNUP_HINT_NAME = 'How we greet you. 2 to 60 characters. No angle brackets.';
export const SIGNUP_FIELD_USERNAME = 'Username';
export const SIGNUP_HINT_USERNAME =
  '3 to 30 characters: letters, digits, dot, dash or underscore. Letters are saved in lower case.';
export const SIGNUP_FIELD_COUNTRY = 'Country (two capital letters, for example GB)';
export const SIGNUP_FIELD_PASSWORD = 'Password';
export const SIGNUP_PASSWORD_RULES_TITLE = 'A good password';
export const SIGNUP_PASSWORD_RULES: readonly string[] = [
  'At least 12 characters. Up to 128.',
  'A phrase of four words is fine. Spaces count.',
  'Not a common password, and not your username or your display name.',
  'You can paste it from a password manager.',
];
export const SIGNUP_FIELD_REPEAT = 'Repeat password';
export const SIGNUP_SHOW = 'Show password';
export const SIGNUP_HIDE = 'Hide password';
export const SIGNUP_ACCEPT_LEAD = 'I accept the ';
export const SIGNUP_ACCEPT_TERMS = 'Terms';
export const SIGNUP_ACCEPT_AND = ' and the ';
export const SIGNUP_ACCEPT_PRIVACY = 'Privacy notice';
export const SIGNUP_ACCEPT_END = '.';
export const SIGNUP_NEW_TAB = ' (opens in a new tab)';
export const SIGNUP_HONEYPOT = 'Leave this field empty';
export const SIGNUP_SUBMIT = 'Create account';
export const SIGNUP_BUSY = 'Creating account';
export const SIGNUP_HAVE_ACCOUNT = 'Already have an account?';
export const SIGNUP_SIGN_IN_LINK = 'Sign in';
export const SIGNUP_ERROR_TITLE = 'Could not create the account';
export const SIGNUP_MISMATCH = 'The two passwords are not the same.';
export const SIGNUP_TERMS_MISSING = 'Tick the box to accept the Terms and the Privacy notice.';

export type PasswordReason =
  | 'too_short'
  | 'too_long'
  | 'common'
  | 'contains_username'
  | 'same_as_name'
  | 'repetitive'
  | 'same_as_current';

export function passwordReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'too_short':
      return 'The password is too short. Use at least 12 characters.';
    case 'too_long':
      return 'The password is too long. Use 128 characters or fewer.';
    case 'common':
      return 'That password is too common. Choose a phrase that is hard to guess.';
    case 'contains_username':
      return 'The password must not contain your username.';
    case 'same_as_name':
      return 'The password must not be your display name.';
    case 'repetitive':
      return 'That password repeats one character. Choose a phrase that is hard to guess.';
    case 'same_as_current':
      return 'Choose a password that is different from the current one.';
    default:
      return 'That password cannot be used. Choose a longer phrase that is hard to guess.';
  }
}

export function signupErrorText(code: string, reason?: string): string {
  switch (code) {
    case 'taken':
      return 'That username is taken.';
    case 'weak_password':
      return passwordReasonText(reason);
    case 'invalid_input':
      return 'Please check the form. The display name needs 2 to 60 characters, the username 3 to 30 letters, digits, dots, dashes or underscores, and the country two capital letters.';
    case 'busy':
      return 'We cannot create accounts right now. Please try again later.';
    case 'rate_limited':
      return 'Too many tries from this connection. Please try again later.';
    case 'csrf':
      return 'That request was refused. Reload the page and try again.';
    default:
      return 'The account could not be created. Please try again.';
  }
}

// ---- Buyer sign in (/signin/buyer) -------------------------------------------------------------------
export const BUYER_SIGNIN_TITLE = 'Buyer sign in';
export const BUYER_SIGNIN_LEDE =
  'Use the username and password you made when you created your account.';
export const BUYER_SIGNIN_USERNAME = 'Username';
export const BUYER_SIGNIN_PASSWORD = 'Password';
export const BUYER_SIGNIN_SUBMIT = 'Sign in';
export const BUYER_SIGNIN_BUSY = 'Signing in';
export const BUYER_SIGNIN_FORGOT = 'Forgot your password?';
export const BUYER_SIGNIN_CREATE = 'Create an account';
export const BUYER_SIGNIN_ERROR_TITLE = 'Could not sign in';
/** The one failure message. It is the same for an unknown name, a wrong password and a locked account. */
export const BUYER_SIGNIN_FAILED = 'That username or password did not work.';
export const SIGNIN_TOO_MANY = 'Too many tries. Wait a few minutes and try again.';

// ---- Seller (/seller, /signin/seller) -----------------------------------------------------------------
export const SELLER_TITLE = 'Publish by the article';
export const SELLER_LEDE = 'Sell single articles to readers who want just one.';
export const SELLER_PREPARE_TITLE = 'What to prepare';
export const SELLER_PREPARE_ITEMS: readonly string[] = [
  'Your publisher name, 2 to 80 characters.',
  'Your country, as two capital letters, for example GB.',
  'A website or a public profile that shows who you are. It goes into the note on your application.',
  'Later, a PayPal business account to receive payouts. You do not need it to apply.',
  'A few minutes to read the Publisher terms.',
];
export const SELLER_TERMS_LINK = 'Read the Publisher terms';
export const SELLER_HOW_TITLE = 'What happens next';
export const SELLER_HOW =
  'Your application appears in Operations. The owners read each one and answer by hand. This demo sends no email, so keep your reference and use the status page. Signing in as a publisher is set up by the owners after they approve you.';
export const SELLER_APPLY = 'Apply to publish';
export const SELLER_STATUS = 'Check an application';
export const SELLER_SIGN_IN = 'Sign in';

export const SELLER_SIGNIN_TITLE = 'Publisher sign in';
export const SELLER_SIGNIN_LEDE =
  'Choose your publisher and enter the publisher passcode. The owners set this up after they approve an application.';
export const SELLER_SIGNIN_PUBLISHER = 'Your publisher';
export const SELLER_SIGNIN_FAILED = 'That passcode did not work. Check it and try again.';
export const SELLER_SIGNIN_APPLY_LEAD = 'No account yet?';
export const SELLER_SIGNIN_APPLY_LINK = 'Apply to publish';

// ---- Operator (/signin/operator) ---------------------------------------------------------------------
export const OPERATOR_SIGNIN_TITLE = 'Operator sign in';
export const OPERATOR_SIGNIN_LEDE =
  'Operators sign in with three things: the passcode, your operator name and the 6 digit code from your authenticator app.';
export const OPERATOR_NAME_LABEL = 'Operator name';
export const OPERATOR_PASSCODE_LABEL = 'Operator passcode';
export const OPERATOR_CODE_LABEL = 'Authenticator code';
export const OPERATOR_CODE_HINT =
  'The 6 digits from your authenticator app. Leave the name and code empty to look and stop PayPal calls only: refunds and switching anything on need the code.';
export const OPERATOR_SIGNIN_FAILED =
  'That did not work. Check the passcode, your name and the current code, then try again.';

// ---- /signin (test personas) -------------------------------------------------------------------------
export const SIGNIN_ROLES_TITLE = 'Choose how you sign in';
export const SIGNIN_ROLE_LINKS: readonly {
  id: 'buyer' | 'seller' | 'operator';
  label: string;
  href: string;
}[] = [
  { id: 'buyer', label: 'Buyer sign in', href: '/signin/buyer' },
  { id: 'seller', label: 'Seller sign in', href: '/signin/seller' },
  { id: 'operator', label: 'Operator sign in', href: '/signin/operator' },
];
export const SIGNIN_TESTERS_TITLE = 'Judges and testers';

// ---- Account (/account) ------------------------------------------------------------------------------
export const ACCOUNT_NAV_LABEL = 'Account';
export const ACCOUNT_TITLE = 'Your account';
export const ACCOUNT_SIGNED_IN_AS = 'Signed in as';
export const ACCOUNT_USERNAME_LABEL = 'Username';
export const ACCOUNT_COUNTRY_LABEL = 'Country';
export const ACCOUNT_NO_PASSWORD =
  'This sign in is a test persona. It has no password. Accounts are for buyers who create one.';
export const ACCOUNT_PASSWORD_TITLE = 'Change your password';
export const ACCOUNT_FIELD_CURRENT = 'Current password';
export const ACCOUNT_FIELD_NEW = 'New password';
export const ACCOUNT_FIELD_REPEAT = 'Repeat new password';
export const ACCOUNT_CHANGE = 'Change password';
export const ACCOUNT_CHANGE_BUSY = 'Changing password';
export const ACCOUNT_CHANGED = 'Password changed. Your other devices were signed out.';
export const ACCOUNT_ERROR_TITLE = 'Could not change the password';
export const ACCOUNT_WRONG_CURRENT = 'That current password did not work.';
export const ACCOUNT_CSRF = 'That request was refused. Sign out, sign in again and try again.';
export const ACCOUNT_ALL_TITLE = 'Sign out everywhere';
export const ACCOUNT_ALL_LEDE = 'This signs you out on every device, including this one.';
export const ACCOUNT_ALL_BUTTON = 'Sign out on all devices';
export const ACCOUNT_ALL_BUSY = 'Signing out';
export const ACCOUNT_ALL_FAILED = 'We could not sign you out. Please try again.';

export function accountPasswordErrorText(code: string, reason?: string): string {
  switch (code) {
    case 'wrong_password':
      return ACCOUNT_WRONG_CURRENT;
    case 'weak_password':
      return passwordReasonText(reason);
    case 'csrf':
    case 'unauthenticated':
      return ACCOUNT_CSRF;
    case 'rate_limited':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'invalid_input':
      return 'Please fill in all three fields.';
    default:
      return 'The password could not be changed. Please try again.';
  }
}

// ---- Lost password (/help/password) ------------------------------------------------------------------
export const HELP_PASSWORD_TITLE = 'Lost your password?';
export const HELP_PASSWORD_LEDE = 'This demo has no email, so there is no reset link.';
export const HELP_PASSWORD_STEPS: readonly string[] = [
  `Write to ${CONTACT_ADDRESS} from any address. Give your username. Never send your password.`,
  'The operator checks the request and sets a temporary password at the terminal.',
  'The operator sends the temporary password back to you.',
  'Sign in with it, then change it on the Account page.',
];
export const HELP_PASSWORD_BACK = 'Back to buyer sign in';
