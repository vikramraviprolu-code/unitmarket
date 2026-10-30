// What the in-app reader shows of a stored article (READER-A). Pure: no HTML, no Markdown rendering,
// no real time. Article text is data; it is split into paragraphs and every paragraph is later shown as
// a React text node.

/** Over this size, or any mime other than the two below, an item opens as a download. */
export const MAX_READER_BYTES = 200 * 1024;

const READABLE_MIMES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown']);

/** True for the two text types the reader shows; parameters such as a charset are ignored. */
export function isReadableMime(mime: string): boolean {
  return READABLE_MIMES.has((mime.split(';')[0] ?? '').trim().toLowerCase());
}

/** Paragraphs are separated by blank lines. Each is trimmed; empty ones are dropped; markup stays text. */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}
