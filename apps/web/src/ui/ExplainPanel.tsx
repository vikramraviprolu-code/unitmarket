import Link from 'next/link';
import { EXPLAIN_NOTE, EXPLAIN_PAUSED, EXPLAIN_SAFE, EXPLAIN_TITLE } from '../lib/explain-view';
import type { ExplainPanelView, ExplainPausedView } from '../lib/explain-view';

// INT-GA / GA.4: the explain panel on an operator order page in the attention group. Two plain-text paragraphs and,
// at most, one link to the catalogue fix page. It never posts and runs nothing: the operator decides.
export function ExplainPanel({ view }: { view: ExplainPanelView | ExplainPausedView }) {
  if ('paused' in view)
    return (
      <section
        aria-labelledby="order-explain-title"
        id="order-explain"
        data-testid="order-explain-paused"
      >
        <h2 id="order-explain-title">{EXPLAIN_TITLE}</h2>
        <p className="ola-hint">{EXPLAIN_PAUSED}</p>
      </section>
    );
  return (
    <section aria-labelledby="order-explain-title" id="order-explain" data-testid="order-explain">
      <h2 id="order-explain-title">{EXPLAIN_TITLE}</h2>
      <p data-testid="explain-what">{view.what_happened}</p>
      <h3>{EXPLAIN_SAFE}</h3>
      <p data-testid="explain-safe">{view.safe_now}</p>
      {view.button !== null ? (
        <p>
          <Link className="btn btn-primary" href={view.button.href} data-testid="explain-fix">
            {view.button.label}
          </Link>
        </p>
      ) : null}
      <p className="ola-hint">{EXPLAIN_NOTE}</p>
    </section>
  );
}
