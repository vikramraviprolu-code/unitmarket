// Origin: AIC_Hackathon_UnitMarket@a99204b:packages/core/catalogue/search.ts. Adapted; owned by SBX.
// API-A (A0): plain catalogue text search for the public API. Rank offers by how many words of the query
// their title and abstract share (more first), then by price (lowest first), then by offer id. Pure and
// deterministic: no database, no clock, no randomness. Only authorised offers are ever returned. The
// simulation's version also reads pools and ledger data; none of that is here.

/** What the search needs to know about one offer. Extra fields on the caller's object are kept. */
export interface SearchCandidate {
  offer_id: string;
  title: string;
  abstract: string;
  publisher_slug: string;
  /** Only `authorised` is ever returned. */
  status: string;
  /** The lowest price over the offer's options, in minor units. */
  min_price_minor: number;
}

export interface SearchQuery {
  /** Free text. Empty (or only words under three characters) means "everything". */
  q?: string;
  /** Keep one publisher, by slug. */
  publisher?: string;
  /** Keep offers whose lowest price is at or under this, in minor units. */
  max_price_minor?: number;
}

// Lowercase words of letters and digits, at least three characters, each counted once, sorted.
export function needWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  return [...new Set(words)].sort();
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function searchOffers<T extends SearchCandidate>(
  items: readonly T[],
  query: SearchQuery,
): T[] {
  const wanted = needWords(query.q ?? '');
  const scored: { item: T; relevance: number }[] = [];
  for (const item of items) {
    if (item.status !== 'authorised') continue;
    if (query.publisher !== undefined && item.publisher_slug !== query.publisher) continue;
    if (query.max_price_minor !== undefined && item.min_price_minor > query.max_price_minor)
      continue;
    const text = new Set(needWords(`${item.title} ${item.abstract}`));
    const relevance = wanted.filter((w) => text.has(w)).length;
    if (wanted.length > 0 && relevance === 0) continue;
    scored.push({ item, relevance });
  }
  return scored
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        a.item.min_price_minor - b.item.min_price_minor ||
        byId(a.item.offer_id, b.item.offer_id),
    )
    .map((s) => s.item);
}
