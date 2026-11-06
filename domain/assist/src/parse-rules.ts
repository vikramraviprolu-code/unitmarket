// INT-GA / GA.1: plain words to a TxnQuery string map, by rules only (no model call). Personal data is taken out
// first (scrub.ts). Then dates (from the injected `now`, UTC), amounts and their currency ("p" is GBP, "$" USD,
// "£" GBP, "€" EUR, "c" or "cents" USD), the status words of STATUS_GROUPS, refund and case words, and seller names
// from the context. What no rule places is `rest`; when every word left is a filler word, `rest` is empty and the
// model is not asked.
import { ASSIST_SYNONYMS } from '@umsbx/contracts';
import { ChipSet } from './chips';
import type { AssistRole } from './chips';
import { GAP, scrub } from './scrub';

export interface AssistContext {
  /** The role the server applies (REFUSED_FIELDS key): buyer, agent, publisher, operator_key or operator. */
  role: AssistRole;
  /** Seller names this person may name: a buyer the catalogue publishers, a seller itself, an operator all. */
  sellers: readonly string[];
}

export interface RuleResult {
  chips: Record<string, string>;
  /** The words no rule placed, lower case; empty when only filler words are left. */
  rest: string;
  /** Fields that were asked for but cannot be used by this role or could not be placed. */
  dropped: string[];
}

/** The longest text read; anything after it is ignored, never refused. */
export const ASK_TEXT_MAX = 500;

const DAY_MS = 86_400_000;
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Words that carry no filter on their own: when only these are left, there is nothing to ask the model. */
export const FILLER: ReadonlySet<string> = new Set(
  (
    'a all an and any are at be been bought buy by did do does every find for from get had has have i in is it ' +
    'its just list made me my of on one ones only or order orders payment payments placed please purchase ' +
    'purchases sale sales see show sold that the their them there these things this those to transaction ' +
    'transactions was were what where which with item items'
  ).split(' '),
);

/** Status, refund and case phrases, matched on whole words, longest first at each position. */
const VOCAB: Readonly<Record<string, readonly [string, string]>> = {
  'needs attention': ['status', 'attention'],
  'need attention': ['status', 'attention'],
  attention: ['status', 'attention'],
  unresolved: ['status', 'attention'],
  frozen: ['status', 'attention'],
  mismatch: ['status', 'attention'],
  'reversal suspected': ['status', 'attention'],
  'partly refunded': ['status', 'part_refunded'],
  'partially refunded': ['status', 'part_refunded'],
  'part refunded': ['status', 'part_refunded'],
  refunded: ['status', 'refunded'],
  reversed: ['status', 'refunded'],
  paid: ['status', 'paid'],
  captured: ['status', 'paid'],
  failed: ['status', 'failed'],
  abandoned: ['status', 'failed'],
  declined: ['status', 'failed'],
  'in progress': ['status', 'in_progress'],
  'awaiting buyer': ['status', 'in_progress'],
  pending: ['status', 'in_progress'],
  'refund requested': ['refund', 'requested'],
  'refunds requested': ['refund', 'requested'],
  'requested a refund': ['refund', 'requested'],
  'partial refund': ['refund', 'partial'],
  'partial refunds': ['refund', 'partial'],
  'full refund': ['refund', 'full'],
  'full refunds': ['refund', 'full'],
  'no refund': ['refund', 'none'],
  'no refunds': ['refund', 'none'],
  'open case': ['case', 'open'],
  'open cases': ['case', 'open'],
  'resolved case': ['case', 'resolved'],
  'resolved cases': ['case', 'resolved'],
  'closed case': ['case', 'resolved'],
  'closed cases': ['case', 'resolved'],
  'no case': ['case', 'none'],
  'no cases': ['case', 'none'],
};

/** Words the other rules and the word table use: a name phrase stops at one of these. */
const KNOWN: ReadonlySet<string> = new Set([
  ...FILLER,
  ...Object.keys(VOCAB).flatMap((p) => p.split(' ')),
  ...Object.keys(ASSIST_SYNONYMS).flatMap((p) => p.split(' ')),
  ...Object.keys(MONTHS),
  ...'today yesterday since last past this week month days day over under above below between more less than at least most up cheaper'.split(
    ' ',
  ),
]);

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const utcDay = (now: Date): number =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

function validDate(y: number, m: number, d: number): number | null {
  const t = Date.UTC(y, m - 1, d);
  const x = new Date(t);
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? t : null;
}

function dates(s: string, now: Date, set: ChipSet): string {
  const today = utcDay(now);
  const range = (from: number, to: number | null): string => {
    if (!set.has('from') && !set.has('to')) {
      set.place('from', iso(from));
      if (to !== null) set.place('to', iso(to));
    }
    return GAP;
  };
  const since = (d: number, m: number): string => {
    const y = now.getUTCFullYear();
    let t = validDate(y, m, d);
    if (t !== null && t > today) t = validDate(y - 1, m, d);
    if (t === null) {
      set.drop('from');
      return GAP;
    }
    return range(t, null);
  };
  let out = s;
  out = out.replace(
    new RegExp(`\\bsince\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b`, 'g'),
    (_m, d: string, mo: string) => since(Number(d), MONTHS[mo]!),
  );
  out = out.replace(
    new RegExp(`\\bsince\\s+(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'),
    (_m, mo: string, d: string) => since(Number(d), MONTHS[mo]!),
  );
  out = out.replace(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/g, (_m, n: string) =>
    range(today - Number(n) * DAY_MS, today),
  );
  out = out.replace(/\b(?:last|past)\s+week\b/g, () => range(today - 7 * DAY_MS, today));
  out = out.replace(/\bthis\s+month\b/g, () => {
    const d = new Date(today);
    return range(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), today);
  });
  out = out.replace(/\blast\s+month\b/g, () => {
    const d = new Date(today);
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - DAY_MS;
    return range(first, end);
  });
  out = out.replace(/\byesterday\b/g, () => range(today - DAY_MS, today - DAY_MS));
  out = out.replace(/\btoday\b/g, () => range(today, today));
  return out;
}

const NUM = '(\\d{1,7}(?:\\.\\d{1,2})?)';
const AMOUNT = `(?:([$£€])\\s?${NUM}|${NUM}\\s?(pence|p|cents|cent|c|dollars|dollar|pounds|pound|euros|euro)\\b|${NUM})`;
const SYMBOL: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR' };
const SUFFIX: Record<string, [string, boolean]> = {
  p: ['GBP', true],
  pence: ['GBP', true],
  c: ['USD', true],
  cent: ['USD', true],
  cents: ['USD', true],
  dollar: ['USD', false],
  dollars: ['USD', false],
  pound: ['GBP', false],
  pounds: ['GBP', false],
  euro: ['EUR', false],
  euros: ['EUR', false],
};

/** One amount match to minor units and a currency (null when none was written). */
function amountOf(g: (string | undefined)[]): { minor: number; currency: string | null } {
  const [sym, n1, n2, suf, n3] = g;
  if (sym !== undefined && n1 !== undefined)
    return { minor: Math.round(Number(n1) * 100), currency: SYMBOL[sym] ?? null };
  if (suf !== undefined && n2 !== undefined) {
    const [currency, minorUnits] = SUFFIX[suf]!;
    return { minor: Math.round(Number(n2) * (minorUnits ? 1 : 100)), currency };
  }
  return { minor: Math.round(Number(n3) * 100), currency: null };
}

function amounts(s: string, set: ChipSet): string {
  const put = (
    field: 'min_minor' | 'max_minor',
    a: { minor: number; currency: string | null },
  ): void => {
    const cur = set.chips['currency'];
    if (a.currency !== null && cur !== undefined && cur !== a.currency) {
      set.drop(field);
      return;
    }
    if (a.currency !== null && cur === undefined) set.place('currency', a.currency);
    if (!set.has(field)) set.place(field, String(a.minor));
  };
  let out = s.replace(
    new RegExp(`\\bbetween\\s+${AMOUNT}\\s+and\\s+${AMOUNT}`, 'g'),
    (...m: unknown[]) => {
      const g = m.slice(1, 11) as (string | undefined)[];
      put('min_minor', amountOf(g.slice(0, 5)));
      put('max_minor', amountOf(g.slice(5, 10)));
      return GAP;
    },
  );
  const MIN = '(?:over|above|more\\s+than|greater\\s+than|at\\s+least)';
  const MAX = '(?:under|below|less\\s+than|cheaper\\s+than|at\\s+most|up\\s+to)';
  out = out.replace(new RegExp(`(?:^|(?<=\\s))${MIN}\\s+${AMOUNT}`, 'g'), (...m: unknown[]) => {
    put('min_minor', amountOf(m.slice(1, 6) as (string | undefined)[]));
    return GAP;
  });
  out = out.replace(new RegExp(`(?:^|(?<=\\s))${MAX}\\s+${AMOUNT}`, 'g'), (...m: unknown[]) => {
    put('max_minor', amountOf(m.slice(1, 6) as (string | undefined)[]));
    return GAP;
  });
  return out;
}

const tokenise = (s: string): string[] =>
  s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}|]+|[^\p{L}\p{N}|]+$/gu, ''))
    .filter((w) => w !== '');

/** Left to right, the longest phrase at each position. A matched phrase becomes a gap. */
function phrases(
  words: string[],
  table: ReadonlyMap<string, (set: ChipSet) => void>,
  set: ChipSet,
): string[] {
  const longest = Math.max(1, ...[...table.keys()].map((p) => p.split(' ').length));
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    let hit = 0;
    for (let n = Math.min(longest, words.length - i); n >= 1 && hit === 0; n -= 1) {
      const act = table.get(words.slice(i, i + n).join(' '));
      if (act !== undefined) {
        act(set);
        hit = n;
      }
    }
    if (hit > 0) {
      out.push('|');
      i += hit;
    } else {
      out.push(words[i]!);
      i += 1;
    }
  }
  return out;
}

export function parseRules(text: string, now: Date, ctx: AssistContext): RuleResult {
  const set = new ChipSet(ctx.role);
  const input = Array.from(text).slice(0, ASK_TEXT_MAX).join('');
  const sellers = [...ctx.sellers].sort((a, b) => b.length - a.length);
  const sellerOf = (name: string): string | null =>
    sellers.find((x) => x.toLowerCase() === name.toLowerCase()) ?? null;
  const operator = ctx.role === 'operator' || ctx.role === 'operator_key';

  let s = scrub(input, set, (w) => KNOWN.has(w), sellerOf, operator);
  s = ` ${s.toLowerCase().replace(/’/g, "'")} `;
  s = dates(s, now, set);
  s = amounts(s, set);

  const table = new Map<string, (set: ChipSet) => void>();
  for (const [p, [field, value]] of Object.entries(VOCAB))
    table.set(p, (c) => c.place(field, value));
  // A seller naming itself needs no chip: its scope is already itself.
  for (const name of sellers)
    table.set(
      tokenise(name.toLowerCase()).join(' '),
      ctx.role === 'publisher' ? () => undefined : (c) => c.place('seller', name),
    );
  const left = phrases(tokenise(s), table, set).filter((w) => w !== '|');
  const rest = left.every((w) => FILLER.has(w)) ? '' : left.join(' ');
  return { chips: { ...set.chips }, rest, dropped: [...set.dropped] };
}
