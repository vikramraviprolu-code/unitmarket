'use client';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import {
  OPS_SITTING_BUTTON,
  OPS_SITTING_ERROR_TITLE,
  OPS_SITTING_HEADING,
  OPS_SITTING_LEDE,
  OPS_SITTING_REASON_LABEL,
  sittingDoneText,
} from '../../lib/ops-copy';
import { ErrorState } from '../../ui/ErrorState';

export interface SittingResult {
  approval_ref: string;
  scope: string;
  valid_until: string;
  max_amount_minor: number;
  max_calls: number;
}

// OPS-SW (D-118): "Open a PayPal sitting". A reason only: the limits are fixed on the server (D-094) and the
// body carries none. The route checks the authenticator code again. After it, Start appears on refresh.
export function OpenSittingButton({ onOpened }: { onOpened: (r: SittingResult) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SittingResult | null>(null);
  async function open() {
    setBusy(true);
    setError(null);
    const r = await postJson<SittingResult>('/api/ops/sitting', { reason });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : r.message);
      return;
    }
    setDone(r.data);
    onOpened(r.data);
  }
  const disabled = busy || reason.trim().length < 3;
  return (
    <section aria-labelledby="sitting-heading" data-testid="ops-sitting-form">
      <h3 id="sitting-heading">{OPS_SITTING_HEADING}</h3>
      <p className="oh-hint">{OPS_SITTING_LEDE}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void open();
        }}
      >
        <div className="field">
          <label htmlFor="sitting-reason">{OPS_SITTING_REASON_LABEL}</label>
          <input
            id="sitting-reason"
            type="text"
            maxLength={200}
            required
            aria-required="true"
            autoComplete="off"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={disabled}>
          {OPS_SITTING_BUTTON}
        </button>
      </form>
      <p role="status">{done === null ? null : sittingDoneText(done)}</p>
      {error ? <ErrorState title={OPS_SITTING_ERROR_TITLE}>{error}</ErrorState> : null}
    </section>
  );
}
