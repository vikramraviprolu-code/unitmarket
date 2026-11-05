// INT-GA / GA.2: the logic of the ask box. Pure. The server proposes chips for the person's own words; this file
// words them with the filter bar's own labels (lib/filter-bar-view.ts), names what was dropped, and builds the link
// that applies them. Nothing runs until the person applies: the link goes through the bar's own parser, so a refused
// or invalid field can never reach it. An operator without the second factor gets a sign-in line instead of the box.
import { barState, hrefWith } from './filter-bar-view';
import type { BarContext, Chip, FilterPersona, RawMap } from './filter-bar-view';

/** The longest question the route takes (the domain reads no more). */
export const ASK_TEXT_MAX = 500;
export const ASK_MFA_TEXT = 'Sign in with your authenticator to use Ask';
export const ASK_LABEL = 'Ask in your own words';
export const ASK_PLACEHOLDER = 'For example: stuck orders over $5 since 1 Nov';

const DROPPED_WORDS: Readonly<Record<string, string>> = {
  buyer: 'a buyer name or email',
  seller: 'a seller name',
  agent_key: 'an agent key',
  ref: 'a reference you cannot search by',
  number: 'a long number',
  environment: 'the environment',
  flags: 'flags',
  from: 'a date',
  to: 'a date',
  min_minor: 'an amount',
  max_minor: 'an amount',
};

export interface AskView {
  chips: Chip[];
  /** One sentence naming what could not be used, or empty. */
  dropped: string;
  empty: boolean;
  note: string;
}

/** POST /api/assist/query is refused (403) for an operator without the second factor. */
export const askAllowed = (persona: FilterPersona): boolean => persona !== 'operator_key';

export function askView(
  ctx: Extract<BarContext, { kind: 'txn' }>,
  chips: Readonly<Record<string, string>>,
  dropped: readonly string[],
): AskView {
  const shown = barState(ctx, chips).chips;
  const words = [...new Set(dropped.map((f) => DROPPED_WORDS[f] ?? f.replace(/_/g, ' ')))];
  const empty = shown.length === 0 && words.length === 0;
  return {
    chips: shown,
    dropped: words.length === 0 ? '' : `Not used: ${words.join(', ')}.`,
    empty,
    note: empty
      ? 'No filter matched those words. Try other words, or add a filter below.'
      : 'Check these filters, then apply them. Nothing runs until you do.',
  };
}

/** The page link with the proposal merged in: the proposal wins on a field; the bar's parser decides the rest. */
export function askHref(
  ctx: Extract<BarContext, { kind: 'txn' }>,
  basePath: string,
  raw: RawMap,
  proposal: Readonly<Record<string, string>>,
): string {
  const merged: Record<string, string> = { ...barState(ctx, raw).map };
  for (const [k, v] of Object.entries(proposal)) merged[k] = v;
  return hrefWith(basePath, barState(ctx, merged).map);
}
