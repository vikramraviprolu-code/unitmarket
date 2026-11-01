'use client';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import {
  OPS_START_BUTTON,
  OPS_START_ERROR_TITLE,
  OPS_START_HEADING,
  OPS_START_LEDE,
  OPS_START_REASON_LABEL,
  OPS_START_SCOPE_HINT,
  OPS_START_SCOPE_LABEL,
} from '../../lib/ops-copy';
import { ErrorState } from '../../ui/ErrorState';

export interface StartResult {
  outbound_on: true;
  connect_flag: 'on' | 'off';
  calls_left: number;
  valid_until: string;
}

// "Start PayPal" (WEB-OPS-START, ENH-2). A reason and the scope typed back; the route checks everything
// again (the authenticator code, the approval row, the calls left). The scope is a hint, never prefilled,
// so the operator reads it before typing it. It cannot add an approval or set the connection flag.
export function StartButton({
  activeScope,
  onStarted,
}: {
  activeScope: string;
  onStarted: (r: StartResult) => void;
}) {
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    const r = await postJson<StartResult>('/api/ops/start', { reason, confirm_scope: scope });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : r.message);
      return;
    }
    onStarted(r.data);
  }
  return (
    <section aria-labelledby="start-heading">
      <h2 id="start-heading">{OPS_START_HEADING}</h2>
      <p className="oh-hint">{OPS_START_LEDE}</p>
      <div className="field">
        <label htmlFor="start-reason">{OPS_START_REASON_LABEL}</label>
        <input
          id="start-reason"
          type="text"
          maxLength={200}
          autoComplete="off"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="start-scope">{OPS_START_SCOPE_LABEL}</label>
        <input
          id="start-scope"
          type="text"
          maxLength={100}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby="start-scope-hint"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        />
        <p className="oh-hint" id="start-scope-hint">
          {OPS_START_SCOPE_HINT(activeScope)}
        </p>
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy || reason.trim().length < 3 || scope.trim() === ''}
        onClick={() => void start()}
      >
        {OPS_START_BUTTON}
      </button>
      {error ? <ErrorState title={OPS_START_ERROR_TITLE}>{error}</ErrorState> : null}
    </section>
  );
}
