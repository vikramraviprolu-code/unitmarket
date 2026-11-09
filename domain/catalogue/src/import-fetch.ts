// POB-I1 (D-089, review finding): the one door through which the web import reaches the fetcher. The
// may-fetch check (the web_import_enabled switch and maintenance) is asked before EVERY fetch, never once per
// run. A check that says no is `paused`; a check that throws is `check_failed`; a fetcher that throws is a
// refusal with the fixed word `network`. Nothing from an error or a site is kept.
import type { ImportDeps, ImportFetchOutcome } from './import-types';

export type Fetched =
  | { kind: 'ok'; body: string; bytes: Uint8Array; content_type: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'paused' }
  | { kind: 'check_failed' }
  | { kind: 'off' };

const WORD = /^[a-z_]{1,32}$/;

/** A refusal reason from a fetcher, kept only if it is a short fixed word. */
export const fixedWord = (s: unknown): string =>
  typeof s === 'string' && WORD.test(s) ? s : 'network';

export async function fetchChecked(
  deps: Pick<ImportDeps, 'fetcher' | 'mayFetch'>,
  host: string,
  url: string,
  kind: 'text' | 'image',
): Promise<Fetched> {
  const fetcher = deps.fetcher;
  if (fetcher === null) return { kind: 'off' };
  try {
    if (!(await deps.mayFetch())) return { kind: 'paused' };
  } catch {
    return { kind: 'check_failed' };
  }
  let r: ImportFetchOutcome;
  try {
    r = await fetcher.fetch(url, { allow: [host], kind });
  } catch {
    return { kind: 'refused', reason: 'network' };
  }
  if (!r.ok) return { kind: 'refused', reason: fixedWord(r.reason) };
  return { kind: 'ok', body: r.body, bytes: r.bytes, content_type: r.content_type };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const sha256Text = (s: string): Promise<string> => sha256Hex(new TextEncoder().encode(s));
