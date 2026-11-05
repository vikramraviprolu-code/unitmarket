import type { TimelineView } from '../lib/timeline-view';
import './shared-parts.css';

// INT-UI0 / UI0.6: the timeline of one order or unit. It paints what lib/timeline-view.ts returns and decides
// nothing: the order, the words, the empty and the error state all come from there. Until TR1 lands the
// callers pass TIMELINE_FIXTURES. No script, so it is the same with scripts off.
export function Timeline({ view, label }: { view: TimelineView; label: string }) {
  if (view.kind === 'empty')
    return (
      <p className="tl-empty" data-testid="timeline-empty">
        {view.message}
      </p>
    );
  if (view.kind === 'error')
    return (
      <p className="tl-error" role="alert" data-testid="timeline-error">
        {view.message}
      </p>
    );
  return (
    <>
      <ol className="tl" aria-label={label} data-testid="timeline">
        {view.rows.map((r) => (
          <li key={`${r.at}-${String(r.seq)}`} className="tl-step" data-testid="timeline-step">
            <time className="tl-when" dateTime={r.at}>
              {r.when}
            </time>
            <span className="tl-who">
              {r.actor_label} <span className="tl-via">via {r.channel_word}</span>
            </span>
            <span className="tl-what">
              {r.text}
              {r.amount_text !== null ? ` ${r.amount_text}` : ''}
            </span>
            {r.note !== null ? <span className="tl-note">{r.note}</span> : null}
          </li>
        ))}
      </ol>
      {view.truncated !== null ? <p className="tl-cap">{view.truncated}</p> : null}
    </>
  );
}
