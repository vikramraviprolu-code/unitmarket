import type { EntityFact } from '../../lib/ops-entity-view';

// INT-OPS-C: the facts line at the top of an operator buyer or seller page, as a description list. The words
// come from lib/ops-entity-view.ts; this component only lays them out.
export function EntitySummary({ label, facts }: { label: string; facts: EntityFact[] }) {
  return (
    <dl className="pk-facts" aria-label={label} data-testid="entity-summary">
      {facts.map((f) => (
        <div key={f.label} className="pk-fact">
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
