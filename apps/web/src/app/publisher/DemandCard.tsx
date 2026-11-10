import { demandCardView } from '../../lib/demand-copy';
import type { DemandBandText } from '../../lib/demand-copy';

// CAT-2.6: "What buyers ask for" on the publisher home. Up to 5 lines, or the empty sentence.
export function DemandCard({
  rows,
}: {
  rows: readonly { term: string; band: DemandBandText; matching: number }[];
}) {
  const v = demandCardView(rows);
  return (
    <section
      aria-labelledby="demand-h"
      className="pk-section"
      id="demand"
      data-testid="publisher-demand"
    >
      <h2 id="demand-h">{v.heading}</h2>
      {v.empty !== null ? (
        <p className="muted">{v.empty}</p>
      ) : (
        <>
          <ul>
            {v.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted">{v.note}</p>
        </>
      )}
    </section>
  );
}
