'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  DONE_REACTIVATED,
  DONE_SUSPENDED,
  FIELD_REASON,
  REACTIVATE_BUTTON,
  SUSPEND_BUTTON,
  statusErrorText,
} from '../../../lib/ops-publishers-copy';
import { OPS_NEEDS_CODE } from '../../../lib/ops-copy';
import { ErrorState } from '../../../ui/ErrorState';

// PUB-D: suspend or reactivate one publisher. The route does every check; this form only carries the
// publisher id, the wanted status and the reason the operator typed.
export function StatusForm({
  publisherId,
  name,
  suspended,
  hasCode,
}: {
  publisherId: string;
  name: string;
  suspended: boolean;
  /** True for a session with the authenticator code; without it the button is off and says why. */
  hasCode: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = suspended ? 'active' : 'suspended';

  async function change() {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await postJson<{ status: string }>('/api/ops/publishers/status', {
      publisher_id: publisherId,
      status: target,
      reason,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : statusErrorText(r.code));
      return;
    }
    setReason('');
    setDone(target === 'suspended' ? DONE_SUSPENDED : DONE_REACTIVATED);
    router.refresh();
  }

  return (
    <div>
      <div className="field">
        <label htmlFor={`reason-${publisherId}`}>
          {FIELD_REASON} ({name})
        </label>
        <input
          id={`reason-${publisherId}`}
          type="text"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!hasCode || busy || reason.trim().length < 3}
          onClick={() => void change()}
        >
          {suspended ? REACTIVATE_BUTTON : SUSPEND_BUTTON}
        </button>
        {hasCode ? null : <span className="muted"> {OPS_NEEDS_CODE}</span>}
      </div>
      <div aria-live="polite">{done}</div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}
