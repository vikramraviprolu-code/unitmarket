// INT-OPS-B / OPS-B.5: the words of the trace verify tile on Controls > Invariants, and the "verified" mark of
// every timeline (S1). Pure. The tile shows what traceVerifyDetail (composition/ops-controls.ts) answers: TR0's
// own findings, one line each (`chain <key> seq <n>: ...`, `drift <table> <id> <column>`). "Run verify" is a
// plain link to ?verify=1, so nothing runs on a page render and no route or server action is involved (N-B1).
// The mark reads the entries' own `verified` flags: no extra call.

export const RUN_VERIFY_HREF = '/ops/controls/invariants?verify=1';
export const INVARIANTS_HREF = '/ops/money#ops-invariants';
const LINES_SHOWN = 20;

export interface TraceVerifyDetail {
  ok: boolean;
  chains: number;
  rows: number;
  seals: number;
  /** TR0's findings, one line each; empty when everything matches. */
  lines: string[];
}

export type VerifyInput =
  { state: 'idle' } | { state: 'refused' } | { state: 'ran'; detail: TraceVerifyDetail };

export interface VerifyTile {
  kind: 'idle' | 'ok' | 'broken' | 'refused';
  headline: string;
  counts: string | null;
  firstProblem: string | null;
  lines: string[];
  more: string | null;
  runHref: string;
  invariantsHref: string;
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
const BREAK = /^(chain|head|seal|digest) /;

export function verifyTileView(input: VerifyInput): VerifyTile {
  const base = { runHref: RUN_VERIFY_HREF, invariantsHref: INVARIANTS_HREF };
  if (input.state === 'idle')
    return {
      kind: 'idle',
      headline: 'Not run yet',
      counts: null,
      firstProblem: null,
      lines: [],
      more: null,
      ...base,
    };
  if (input.state === 'refused')
    return {
      kind: 'refused',
      headline: 'Needs an operator sign-in',
      counts: null,
      firstProblem: null,
      lines: [],
      more: null,
      ...base,
    };
  const d = input.detail;
  const counts = `${plural(d.chains, 'chain')}, ${plural(d.rows, 'row')}, ${plural(d.seals, 'seal')} checked`;
  if (d.ok && d.lines.length === 0)
    return {
      kind: 'ok',
      headline: 'Verified',
      counts,
      firstProblem: null,
      lines: [],
      more: null,
      ...base,
    };
  return {
    kind: 'broken',
    headline: 'Does not match',
    counts,
    // A broken chain, head, seal or digest is named first: it says the record itself was changed.
    firstProblem: d.lines.find((l) => BREAK.test(l)) ?? d.lines[0] ?? null,
    lines: d.lines.slice(0, LINES_SHOWN),
    more: d.lines.length > LINES_SHOWN ? `and ${String(d.lines.length - LINES_SHOWN)} more` : null,
    ...base,
  };
}

export interface MarkInput {
  seq: number;
  verified: boolean;
}
export interface TimelineMark {
  kind: 'verified' | 'broken';
  text: string;
}

/** "verified" when every entry is; otherwise "first broken row at seq N" for the lowest seq that is not. */
export function timelineMark(entries: readonly MarkInput[]): TimelineMark | null {
  if (entries.length === 0) return null;
  const bad = entries.filter((e) => !e.verified).map((e) => e.seq);
  if (bad.length === 0) return { kind: 'verified', text: 'verified' };
  return { kind: 'broken', text: `first broken row at seq ${String(Math.min(...bad))}` };
}
