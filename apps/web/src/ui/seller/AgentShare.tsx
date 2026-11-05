import type { AgentShareView } from '../../lib/seller-home-view';

// INT-SEL / SEL.3: the share of the last 30 days' sales that an agent bought. Words when there are no sales.
export function AgentShare({ view }: { view: AgentShareView }) {
  return (
    <section
      aria-labelledby="agent-share-h"
      className="pk-section"
      data-testid="seller-agent-share"
    >
      <h2 id="agent-share-h">Bought by agents</h2>
      {view.empty ? (
        <p className="muted">{view.note}</p>
      ) : (
        <>
          <p className="pk-tile-value">{view.value}</p>
          <p className="muted">{view.note}</p>
        </>
      )}
    </section>
  );
}
