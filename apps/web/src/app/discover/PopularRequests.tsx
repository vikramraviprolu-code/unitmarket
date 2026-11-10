'use client';
import { popularRequestsView } from '../../lib/demand-copy';
import type { DemandBandText } from '../../lib/demand-copy';

// CAT-2.6: "Popular requests" chips above the form. Tapping one fills the request box. With no terms the whole
// block, heading included, is absent.
export function PopularRequests({
  terms,
  onPick,
}: {
  terms: readonly { term: string; band: DemandBandText }[];
  onPick: (text: string) => void;
}) {
  const view = popularRequestsView(terms);
  if (view === null) return null;
  return (
    <section aria-labelledby="popular-h" className="popular" data-testid="popular-requests">
      <h2 id="popular-h" className="popular-h">
        {view.heading}
      </h2>
      <p className="hint">{view.hint}</p>
      <ul className="popular-chips">
        {view.chips.map((c) => (
          <li key={c.term}>
            <button type="button" className="btn popular-chip" onClick={() => onPick(c.fill)}>
              {c.term}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
