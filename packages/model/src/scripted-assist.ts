// INT-GA (F2): the scripted answers of the two assist purposes. Rules, not lookups: `txn_query` reads the shared
// word table (ASSIST_SYNONYMS in contracts) on whole words, longest phrase first; `explain_order` picks the first fix
// id (the composition orders them by catalogue severity) that is an alert kind on the order, and builds its two
// sentences from the steps' words keys. No network, no clock, no randomness, no spend. The prompts are not read here.
import { ASSIST_SORT_DIR, ASSIST_SYNONYMS } from '@umsbx/contracts';
import type { ExplainInput, ExplainOutput } from './schemas';
import { MAX_EXPLAIN_TEXT } from './schemas';

/** Fields whose URL value is a comma list (SR0): a second word adds to the list instead of being ignored. */
const LIST_FIELDS = new Set(['currency', 'status', 'refund', 'case', 'flags']);
const PHRASES = Object.keys(ASSIST_SYNONYMS).sort(
  (a, b) => b.length - a.length || (a < b ? -1 : 1),
);

/** Lower case, curly quotes made straight, anything but letters, digits, apostrophes and hyphens a space. */
const normalise = (s: string): string =>
  ` ${s
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .trim()} `;

export function answerTxnQuery(rest: string): Record<string, string> {
  let text = normalise(rest);
  const out: Record<string, string> = {};
  for (const phrase of PHRASES) {
    const needle = ` ${phrase} `;
    if (!text.includes(needle)) continue;
    text = text.split(needle).join(' | ');
    const { field, value } = ASSIST_SYNONYMS[phrase]!;
    const had = out[field];
    if (had === undefined) out[field] = value;
    else if (LIST_FIELDS.has(field) && !had.split(',').includes(value))
      out[field] = `${had},${value}`;
    const dir = ASSIST_SORT_DIR[phrase];
    if (dir !== undefined && out['dir'] === undefined) out['dir'] = dir;
  }
  return out;
}

const words = (key: string): string => key.replace(/[._]+/g, ' ').trim();
const cut = (s: string): string => (s.length > MAX_EXPLAIN_TEXT ? s.slice(0, MAX_EXPLAIN_TEXT) : s);

export function answerExplain(input: ExplainInput): ExplainOutput {
  const action = input.fix_ids.find((k) => input.alert_kinds.includes(k)) ?? 'none';
  const steps = [...input.entries].sort((a, b) => a.seq - b.seq);
  const last = steps[steps.length - 1];
  let what: string;
  if (last === undefined) what = 'No step of this order is on record yet.';
  else {
    const n = steps.length;
    const moved =
      last.state_from !== null && last.state_to !== null
        ? `, moving it from ${words(last.state_from)} to ${words(last.state_to)}`
        : last.state_to !== null
          ? `, leaving it ${words(last.state_to)}`
          : '';
    what = `This order has ${n} recorded step${n === 1 ? '' : 's'}. The last one, ${words(last.words_key)}, came from the ${words(last.actor_kind)} through ${words(last.channel)}${moved}.`;
  }
  if (action !== 'none') what += ` The most serious alert on it is ${words(action)}.`;
  else if (input.alert_kinds.length > 0) what += ' None of its alerts has a fix page.';
  const safe =
    action !== 'none'
      ? `Open the fix page for ${words(action)} and follow its runbook. Never refund or retry twice, and change nothing else until the cause is clear.`
      : 'Nothing here has a fix page. Read the timeline and change nothing until the cause is clear.';
  return { what_happened: cut(what), safe_now: cut(safe), action_id: action };
}
