// BR-6: the words of the operator "Business rules" pages. Plain strings and small pure functions, so the golden
// test pins every line (golden/ops-rules-copy.golden.txt). D-051: no italics, no dashes. The environment word is
// never typed here: the pages take it from the stored environment. The sentence the form shows before submit and
// the one the explain page shows for an old order are the two lines the spec names; both are exact.
import type { RuleKey } from '@umsbx/contracts';
import { formatDateTime } from './format';

export const RULES_TITLE = 'Business rules';
export const RULES_LEDE =
  'The limits that decide how long a buyer can ask for a refund, how long access lasts and how long an agent mandate can run. A change applies to new sales only.';

export const RULES_NEW_LINK = 'Add a setting';
export const RULES_HISTORY_LINK = 'See the history';
export const RULES_EXPLAIN_LINK = 'Explain an order';
export const RULES_EXPORT_BUTTON = 'Download the history as CSV';
export const RULES_BACK_LINK = 'Back to business rules';

export const RULE_LABEL: Record<RuleKey, string> = {
  'refund.request_window': 'Refund window',
  'access.window': 'Access window',
  'mandate.max_days': 'Mandate length',
};
export const RULE_HINT: Record<RuleKey, string> = {
  'refund.request_window': 'How long after access starts a buyer may ask for a refund.',
  'access.window':
    'How long a buyer can read or keep what they bought. It is never shorter than the refund window.',
  'mandate.max_days': 'The longest an agent mandate may run.',
};

export type WritableScope = 'platform' | 'category' | 'seller' | 'buyer';
export const SCOPE_LABEL: Record<WritableScope, string> = {
  platform: 'Everyone',
  category: 'A category',
  seller: 'One seller',
  buyer: 'One buyer',
};

export const daysText = (n: number): string => `${String(n)} ${n === 1 ? 'day' : 'days'}`;
export const rangeText = (min: number, max: number): string => `${String(min)} to ${daysText(max)}`;

export const COL_RULE = 'Rule';
export const COL_NOW = 'Now';
export const COL_RANGE = 'Safe range';
export const COL_APPLIES = 'Can be set for';
export const COL_SELLERS = 'Seller overrides';
export const COL_BUYERS = 'Buyer overrides';
export const COL_LAST = 'Last change';

export const SOURCE_DEFAULT_NOTE = 'Platform default';
/**
 * JR-1: the access window the engine really sells can be higher than the row above it, because it is never below
 * the refund window. When it differs, one extra line says so; otherwise nothing.
 */
export const inForceLine = (inForce: number, shown: number): string | null =>
  inForce === shown
    ? null
    : `In force now: ${daysText(inForce)} (raised to match the refund window)`;

export const NO_CHANGE_YET = 'No change yet. The platform default applies.';

/** The last change of a rule: when, who (only when the viewer has the authenticator code) and why. */
export const lastChangeText = (atIso: string, by: string | null, reason: string): string =>
  `${formatDateTime(atIso)}${by === null ? '' : ` by ${by}`}: ${reason}`;

/** The line the form shows before submit. A blank start says the date is the one the operator picks. */
export const impactLine = (fromIso: string | null): string =>
  `Applies to new sales from ${fromIso === null ? 'the start time you choose' : formatDateTime(fromIso)}. Sales already approved keep their terms.`;

export const MFA_NOTICE =
  'Changing a rule needs your authenticator code. Sign in with it before you add a setting.';

export const FORM_HEADING = 'Add a business rule setting';
export const FIELD_RULE = 'Rule';
export const FIELD_SCOPE = 'Applies to';
export const FIELD_SCOPE_ID = 'Seller or buyer id';
export const FIELD_VALUE = 'Value in days';
export const FIELD_FROM = 'Starts';
export const FIELD_UNTIL = 'Ends';
export const FIELD_REASON = 'Reason';
export const SUBMIT_LABEL = 'Save setting';
export const HINT_SCOPE_ID = 'Only for one seller or one buyer. Copy the id from their page.';
export const HINT_UNTIL = 'Leave empty for no end.';
export const HINT_REASON = 'Say why in a few words. It is kept in the history.';
export const SAVED_LINE = 'Saved. It applies to new sales from the start time.';

export const HISTORY_HEADING = 'History of settings';
export const HISTORY_EMPTY = 'No settings match.';
export const HISTORY_CAPPED = 'Showing the newest 200. Narrow the filter or download the CSV.';
export const INVALID_FILTER = 'That filter is not valid. Clear it and try again.';
export const COL_SET = 'Added';
export const COL_KEY = 'Rule';
export const COL_SCOPE = 'Applies to';
export const COL_VALUE = 'Value';
export const COL_FROM = 'Starts';
export const COL_UNTIL = 'Ends';
export const COL_BY = 'Added by';
export const COL_WHY = 'Reason';
export const FILTER_KEY = 'Rule';
export const FILTER_SCOPE = 'Applies to';
export const FILTER_OPERATOR = 'Added by';
export const FILTER_APPLY = 'Apply filter';
export const FILTER_CLEAR = 'Clear filter';
export const UNTIL_OPEN = 'No end';
export const OPERATOR_HIDDEN = 'Hidden without your authenticator code';

export const EXPLAIN_HEADING = 'Explain an order';
export const EXPLAIN_BLANK = 'Enter an order id to see the terms it was approved under.';
export const EXPLAIN_FIELD = 'Order id';
export const EXPLAIN_BUTTON = 'Show terms';
export const OLD_ORDER_LINE = 'Approved before terms were recorded';
export const COL_TERM = 'Term';
export const COL_SOURCE = 'Where it came from';
export const RULES_VERSION_LABEL = 'Rules version';
export const DIGEST_LABEL = 'Digest';

/**
 * Where a resolved value came from, in words. The resolver writes `default`, `linked:<key>`, `platform:<row>` or
 * `<scope>:<id>@<row>`. A shape this function does not know is shown as recorded, never dropped.
 */
export function sourceText(source: string): string {
  if (source === 'default') return SOURCE_DEFAULT_NOTE;
  if (source.startsWith('linked:')) return 'Raised to match the refund window';
  if (source.startsWith('platform:')) return 'Platform setting';
  const m = /^(seller|buyer|category|agreement):([^@]+)@/.exec(source);
  if (m !== null) {
    const kind = { seller: 'Seller', buyer: 'Buyer', category: 'Category', agreement: 'Agreement' }[
      m[1] as 'seller' | 'buyer' | 'category' | 'agreement'
    ];
    return `${kind} setting (${m[2]!})`;
  }
  return `Recorded as ${source}`;
}

export const EXPLAIN_UNREADABLE = 'The terms stored for this order could not be read.';

export const HINT_TIME = 'All times are UTC. The start must not be in the past.';
export const VALUE_ERROR = 'Enter a whole number of days inside the safe range.';
export const SIGN_IN_AGAIN = 'Please sign in again.';
export const EXPORT_FAILED = 'We could not make the file. Try again in a moment.';
export const EXPORT_TRUNCATED =
  'The file holds the newest 5000 settings. Older ones are in the record but not in the file.';
export const CATEGORY_NOTE = 'A category has no list yet. Type its id exactly.';
