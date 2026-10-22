// Deterministic pack composition: rank by term overlap, then offer_id. Listing text is data:
// it is tokenised for matching and never copied into the output (AI-1).
import { tokenise } from './parse-brief';
import { MAX_PICKS } from './schemas';
import type { ComposeInput, ComposeOutput } from './schemas';

export type { ComposeInput, ComposeOutput } from './schemas';

export function composePack(input: ComposeInput): ComposeOutput {
  const terms = [...new Set(input.terms.map((t) => t.toLowerCase()))];
  const seen = new Set<string>();
  const scored: { offer_id: string; overlap: number }[] = [];
  for (const c of input.candidates) {
    if (seen.has(c.offer_id)) continue;
    seen.add(c.offer_id);
    const words = new Set(tokenise(`${c.title} ${c.abstract} ${c.topics.join(' ')}`));
    const overlap = terms.filter((t) => words.has(t)).length;
    if (overlap > 0) scored.push({ offer_id: c.offer_id, overlap });
  }
  scored.sort(
    (a, b) =>
      b.overlap - a.overlap || (a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0),
  );
  return {
    picks: scored.slice(0, MAX_PICKS).map((s) => ({
      offer_id: s.offer_id,
      reason: `Matches ${s.overlap} of ${terms.length} of your terms.`,
    })),
    tool_calls: [],
  };
}
