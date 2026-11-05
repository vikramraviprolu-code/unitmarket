import type { CaseCardView } from '../../lib/buyer-order-view';
import './buyer.css';

// INT-BUY / BUY.3: the help case of an order, as steps and a due time. It paints what lib/buyer-order-view.ts returns.
export function CaseCard({ view }: { view: CaseCardView }) {
  return (
    <section className="case-card cap-card" aria-label="Your help request" data-testid="case-card">
      <h2>Your help request</h2>
      <p>{view.message}</p>
      <ol aria-label="Steps of your help request">
        {view.steps.map((s) => (
          <li key={s.label} aria-current={s.current ? 'step' : undefined}>
            {s.done ? 'Done: ' : s.current ? 'Now: ' : 'Next: '}
            {s.label}
          </li>
        ))}
      </ol>
      {view.due_text !== null ? <p data-testid="case-due">{view.due_text}</p> : null}
    </section>
  );
}
