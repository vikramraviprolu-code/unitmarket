// INT-UI0 / UI0.4: the one display form of an order reference, and what the copy control copies. Pure.
// The short form is the last 6 characters behind an ellipsis, so it cannot be taken for a whole
// reference. The copy text is always the whole reference, whichever form is on screen. A value that is not
// a plausible reference (empty, spaces, control or bidi characters, over 200 characters) shows and copies
// nothing, so odd stored text never reaches the clipboard.
export const SHORT_REF_LENGTH = 6;
const MAX_REF = 200;

/** A reference as the engine writes ids: visible characters only, no spaces. */
export function isRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= MAX_REF && /^[\x21-\x7e]+$/.test(ref);
}

/** The last 6 characters, or the whole reference when it is that short. */
export function shortRef(ref: string): string {
  return isRef(ref) ? ref.slice(-SHORT_REF_LENGTH) : '';
}

export type RefForm = 'short' | 'full';

export function displayRef(ref: string, form: RefForm = 'short'): string {
  if (!isRef(ref)) return '';
  if (form === 'full' || ref.length <= SHORT_REF_LENGTH) return ref;
  return `…${shortRef(ref)}`;
}

/** What the copy control puts on the clipboard: the full reference. */
export function copyText(ref: string): string {
  return isRef(ref) ? ref : '';
}
