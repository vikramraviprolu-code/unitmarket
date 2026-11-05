import type { HealthLight } from '../../lib/ops-health-view';
import { Chip } from '../publisher/kit';
import './ops-a.css';

// INT-OPS-A / OPS-A.1: the four health lights of Home. Each says its state in words and carries a tone, so colour
// is never the only signal. The words come from lib/ops-health-view.ts; this paints them and decides nothing.
export function HealthLights({ lights }: { lights: HealthLight[] }) {
  return (
    <section aria-label="System health" data-testid="health-lights">
      <ul className="ola-lights">
        {lights.map((l) => (
          <li key={l.id} className="ola-light" data-testid={`health-light-${l.id}`}>
            <span className="ola-light-label">{l.label}</span>
            <Chip tone={l.tone}>{l.word}</Chip>
          </li>
        ))}
      </ul>
    </section>
  );
}
