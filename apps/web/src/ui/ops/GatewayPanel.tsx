import { Chip } from '../publisher/kit';
import type { GatewayView } from '../../lib/gateway-view';

// INT-CTL / CTL.1: the five locks in words, read only. It paints what lib/gateway-view.ts returns; there is no
// control here, because every lock is turned from the owner's terminal or the host's settings.
export function GatewayPanel({ view }: { view: GatewayView }) {
  return (
    <div className="pk-panel" data-testid="gateway-panel">
      <p role="status" data-testid="gateway-summary">
        <Chip tone={view.all_open ? 'good' : 'warn'}>{view.summary}</Chip>
      </p>
      <ul className="oh-list" aria-label="The five locks">
        {view.locks.map((l) => (
          <li key={l.lock} data-testid={`gateway-${l.lock}`}>
            <span>{l.line}</span>
            {l.owner_action !== null ? <p className="oh-hint">{l.owner_action}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
