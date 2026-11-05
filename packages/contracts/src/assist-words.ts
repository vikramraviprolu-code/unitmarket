// INT-GA (F2): the shared word table of the plain-words search. Words and short phrases that the rule parser in
// domain/assist does not place (it handles dates, amounts, status, refund and case words, seller names and the
// personal-data shapes) mapped to one TxnQuery field and value. The scripted model answers `txn_query` from this
// table; it lives here because packages/model cannot import domain/assist. A value is a URL string value, so a
// list field may be met twice and the values are joined with a comma. Matching is on whole words, lower case,
// longest phrase first. This is a vocabulary, not a list of questions: no query text belongs here.
export interface AssistSynonym {
  readonly field: string;
  readonly value: string;
}

export const ASSIST_SYNONYMS: Readonly<Record<string, AssistSynonym>> = {
  // status (F4)
  stuck: { field: 'status', value: 'attention' },
  'on hold': { field: 'status', value: 'attention' },
  'held up': { field: 'status', value: 'attention' },
  'went wrong': { field: 'status', value: 'failed' },
  'not go through': { field: 'status', value: 'failed' },
  "didn't go through": { field: 'status', value: 'failed' },
  bounced: { field: 'status', value: 'failed' },
  'still waiting': { field: 'status', value: 'in_progress' },
  unfinished: { field: 'status', value: 'in_progress' },
  'not finished': { field: 'status', value: 'in_progress' },
  // refund
  'money back': { field: 'refund', value: 'requested' },
  'asked for a refund': { field: 'refund', value: 'requested' },
  // case
  dispute: { field: 'case', value: 'open' },
  disputed: { field: 'case', value: 'open' },
  disputes: { field: 'case', value: 'open' },
  complaint: { field: 'case', value: 'open' },
  complaints: { field: 'case', value: 'open' },
  // channel
  'my agent': { field: 'channel', value: 'agent' },
  'an agent': { field: 'channel', value: 'agent' },
  'the agent': { field: 'channel', value: 'agent' },
  'by agent': { field: 'channel', value: 'agent' },
  'my agents': { field: 'channel', value: 'agent' },
  myself: { field: 'channel', value: 'human' },
  'by hand': { field: 'channel', value: 'human' },
  'by me': { field: 'channel', value: 'human' },
  // currency by name
  dollars: { field: 'currency', value: 'USD' },
  'us dollars': { field: 'currency', value: 'USD' },
  pounds: { field: 'currency', value: 'GBP' },
  sterling: { field: 'currency', value: 'GBP' },
  euros: { field: 'currency', value: 'EUR' },
  // environment (operators only; the role table drops it for anyone else)
  sandbox: { field: 'environment', value: 'sandbox' },
  'dry run': { field: 'environment', value: 'dryrun' },
  'dry-run': { field: 'environment', value: 'dryrun' },
  // flags (operators only)
  flagged: { field: 'flags', value: 'alert' },
  'with an alert': { field: 'flags', value: 'alert' },
  'unknown operation': { field: 'flags', value: 'unknown_op' },
  mismatched: { field: 'flags', value: 'mismatch' },
  // sort
  biggest: { field: 'sort', value: 'amount' },
  largest: { field: 'sort', value: 'amount' },
  'most expensive': { field: 'sort', value: 'amount' },
  cheapest: { field: 'sort', value: 'amount' },
  smallest: { field: 'sort', value: 'amount' },
  'newest first': { field: 'sort', value: 'newest' },
  'latest first': { field: 'sort', value: 'newest' },
  'oldest first': { field: 'sort', value: 'newest' },
};

/**
 * The sort direction a sort word implies. Kept apart from the table above because one word sets two fields.
 * Biggest first is `desc`; cheapest first and oldest first are `asc`.
 */
export const ASSIST_SORT_DIR: Readonly<Record<string, 'asc' | 'desc'>> = {
  biggest: 'desc',
  largest: 'desc',
  'most expensive': 'desc',
  cheapest: 'asc',
  smallest: 'asc',
  'newest first': 'desc',
  'latest first': 'desc',
  'oldest first': 'asc',
};
