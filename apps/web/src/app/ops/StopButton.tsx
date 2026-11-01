'use client';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import { ErrorState } from '../../ui/ErrorState';

// "Stop PayPal now" (BU-2). Turns the outbound switch off. Turning it back on is the Start control next
// to it (an operator with the authenticator code, WEB-OPS-START) or `pnpm safety:resume` at the terminal.
export function StopButton() {
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
  }
  return (
    <section aria-labelledby="stop-heading">
      <h2 id="stop-heading">Stop PayPal calls</h2>
      <div className="field">
        <label htmlFor="stop-reason">Why are you stopping PayPal calls?</label>
        <input
          id="stop-reason"
          type="text"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn"
        disabled={state === 'busy' || reason.trim() === ''}
        onClick={() => void stop()}
      >
        Stop PayPal now
      </button>
      <div aria-live="polite" data-testid="ops-stop-result">
        {state === 'done'
          ? 'PayPal calls are stopped (in force within 5 seconds). To turn them on again, use Start PayPal with your authenticator code, or the owner runs pnpm safety:resume at their terminal.'
          : null}
      </div>
      {error ? <ErrorState title="Could not stop">{error}</ErrorState> : null}
    </section>
  );
}
