// INT-GA (F6): personal data never leaves. Before any other rule reads the text, these shapes are found and taken
// out: emails, order refs (the `ord_` id and the display form, an ellipsis and up to six characters), PayPal id
// shapes (order, capture and refund ids: 10 to 30 capital letters and digits with at least one of each), digit runs
// of six or more, and "buyer <Name>" / "seller <Name>" phrases. Each becomes a chip when the role may filter on it
// and is dropped otherwise. It is never left in the text, so it can never reach the rest the model sees.
import type { ChipSet } from './chips';

/** What replaces a removed span: a marker no rule matches and the rest never keeps. */
export const GAP = ' | ';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ORDER_REF = /\bord_[A-Za-z0-9_]+/g;
const DISPLAY_REF = /(?:…|\.\.\.)\s?([A-Za-z0-9_]{1,6})(?![A-Za-z0-9_])/g;
const PROVIDER_ID = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,30}\b/g;
const DIGITS = /\d{6,}/g;
const NAME_WORD = /^[\p{L}][\p{L}'.-]*$/u;
const MAX_NAME_WORDS = 3;

const trimPunct = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const possessive = (w: string): string => w.replace(/['’]s$/i, '');

/**
 * Take the personal-data shapes out of `text`. `isWord` tells a name word from a word the other rules or the word
 * table know (so "buyer Carol Jones money back" keeps "money back" for the model). `sellerOf` gives the catalogue
 * spelling of a seller name, when there is one.
 */
export function scrub(
  text: string,
  set: ChipSet,
  isWord: (lower: string) => boolean,
  sellerOf: (name: string) => string | null,
  operator: boolean,
): string {
  let s = text.replace(EMAIL, (m) => {
    set.place('buyer', m);
    return GAP;
  });
  s = s.replace(ORDER_REF, (m) => {
    set.place('ref', m);
    return GAP;
  });
  s = s.replace(DISPLAY_REF, (_m, ref: string) => {
    set.place('ref', ref);
    return GAP;
  });
  s = s.replace(PROVIDER_ID, (m) => {
    if (operator) set.place('ref', m);
    else set.drop('ref');
    return GAP;
  });
  s = s.replace(DIGITS, () => {
    set.drop('number');
    return GAP;
  });
  return namePhrases(s, set, isWord, sellerOf);
}

function namePhrases(
  s: string,
  set: ChipSet,
  isWord: (lower: string) => boolean,
  sellerOf: (name: string) => string | null,
): string {
  const words = s.split(/\s+/).filter((w) => w !== '');
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const role = trimPunct(words[i]!).toLowerCase();
    if (role !== 'buyer' && role !== 'seller') {
      out.push(words[i]!);
      continue;
    }
    const name: string[] = [];
    let j = i + 1;
    while (j < words.length && name.length < MAX_NAME_WORDS) {
      const raw = words[j]!;
      const w = possessive(trimPunct(raw));
      if (w === '' || !NAME_WORD.test(w) || isWord(w.toLowerCase())) break;
      name.push(w);
      j += 1;
      // A possessive or a trailing comma ends the name ("buyer Ann Lee's orders").
      if (w !== trimPunct(raw) || /[,;:.!?]$/.test(raw)) break;
    }
    if (name.length === 0) {
      out.push(words[i]!);
      continue;
    }
    const value = name.join(' ');
    if (role === 'buyer') set.place('buyer', value);
    else set.place('seller', sellerOf(value) ?? value);
    out.push(GAP.trim());
    i = j - 1;
  }
  return out.join(' ');
}
