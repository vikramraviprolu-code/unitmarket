'use client';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import { OPS_STOP_DONE } from '../../lib/ops-copy';
import { ErrorState } from '../../ui/ErrorState';

// "Stop PayPal now" (BU-2). Turns the outbound switch off. Turning it back on is the Start control next
// to it (an operator signed in with the authenticator code, WEB-OPS-START) or `pnpm safety:resume` at the terminal.
export function StopButton({ onStopped }: { onStopped?: () => void } = {}) {
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    setState('busy');
    setError(null);
    const r = await postJson<{ outbound_on: boolean }>('/api/ops/stop', { reason });
    if (!r.ok) {
      setState('idle');
      setError(r.status === 401 ? 'Please sign in again.' : r.message);
      return;
    }
    setState('done');
    onStopped?.();
  }
  return (
    <section aria-labelledby="stop-heading">
      <h3 id="stop-heading">Stop PayPal calls</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (state !== 'busy' && reason.trim() !== '') void stop();
        }}
      >
        <div className="field">
          <label htmlFor="stop-reason">Why are you stopping PayPal calls?</label>
          <input
            id="stop-reason"
            type="text"
            maxLength={200}
            required
            aria-required="true"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={state === 'busy' || reason.trim() === ''}>
          Stop PayPal now
        </button>
      </form>
      <div aria-live="polite" data-testid="ops-stop-result">
        {state === 'done' ? OPS_STOP_DONE : null}
      </div>
      {error ? <ErrorState title="Could not stop">{error}</ErrorState> : null}
    </section>
  );
}
