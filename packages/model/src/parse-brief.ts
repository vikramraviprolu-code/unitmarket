// Adapted from AIC_Hackathon_UnitMarket simulation/consumers/src/parse.ts at a36ddc03fd0b962000f686291c145b50ee337f90.
// Deterministic regex brief parser. Integer arithmetic only. No clock, no randomness.
import type { BriefParseOutput } from './schemas';

const INVISIBLE = /[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const MAX_MINOR = 1_000_000_000;

const CURRENCY_WORDS: [RegExp, string][] = [
  [/\b(?:usd|dollars?|bucks)\b/i, 'USD'],
  [/\b(?:eur|euros?)\b/i, 'EUR'],
  [/\b(?:gbp|pounds?)\b/i, 'GBP'],
];
const SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const LANGUAGES: Record<string, string> = {
  english: 'en',
  german: 'de',
  deutsch: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
};
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'on',
  'with',
  'about',
  'some',
  'any',
  'me',
]);

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{1,2})(?!\d))?`;
const SYMBOL_AMOUNT = new RegExp(String.raw`([$€£])\s?${NUM}`);
const WORD_AMOUNT = new RegExp(
  String.raw`(?<![\d.,])${NUM}\s*(dollars?|usd|euros?|eur|pounds?|gbp)\b`,
  'i',
);
const CUE =
  /\b(?:under|below|max|maximum|up to|at most|budget|less than|download|keep|retrieve|view|read online|online|english|german|deutsch|french|spanish|italian|portuguese)\b|[$€£]/i;
const PREFIX = /^(?:i\s+)?(?:need|needs|want|am looking for|looking for|find me|find)\b[:\s]*/i;

function toMinor(whole: string, fraction: string | undefined): number | null {
  const digits = whole.replace(/,/g, '');
  if (digits.length > 8) return null;
  const minor = Number(digits) * 100 + Number((fraction ?? '').padEnd(2, '0'));
  return minor > MAX_MINOR ? null : minor;
}

function wordCurrency(text: string): string | null {
  for (const [re, code] of CURRENCY_WORDS) if (re.test(text)) return code;
  return null;
}

export function cleanText(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch;
  }
  return out.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && t.length <= 40);
}

export function parseBrief(raw: string): BriefParseOutput {
  const text = cleanText(raw);

  let ceiling: number | null = null;
  let currency: string | null = null;
  const sym = SYMBOL_AMOUNT.exec(text);
  const wrd = WORD_AMOUNT.exec(text);
  if (sym) {
    ceiling = toMinor(sym[2]!, sym[3]);
    currency = SYMBOLS[sym[1]!]!;
  } else if (wrd) {
    ceiling = toMinor(wrd[1]!, wrd[2]);
    currency = wordCurrency(wrd[3]!);
  } else {
    currency = wordCurrency(text);
  }

  const lower = text.toLowerCase();
  const option: BriefParseOutput['option'] = /\b(?:download|keep|retrieve)\b/.test(lower)
    ? 'keep_retrieve'
    : /\b(?:view|read online|online)\b/.test(lower)
      ? 'online_read'
      : null;

  const lang = /\b(english|german|deutsch|french|spanish|italian|portuguese)\b/.exec(lower);
  const language = lang ? LANGUAGES[lang[1]!]! : null;

  const cut = CUE.exec(text);
  let need = (cut ? text.slice(0, cut.index) : text).replace(/[\s.,;:]+$/, '');
  need = need.replace(PREFIX, '').trim();
  if (need === '') need = text.replace(PREFIX, '').trim() || text;

  const terms: string[] = [];
  for (const t of tokenise(need)) {
    if (!STOPWORDS.has(t) && !terms.includes(t)) terms.push(t);
    if (terms.length === 12) break;
  }
  return { need, ceiling_minor: ceiling, currency, option, language, terms };
}
