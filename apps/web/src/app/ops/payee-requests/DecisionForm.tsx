'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  OPS_DONE_REJECTED,
  OPS_DONE_VERIFIED,
  OPS_FIELD_REASON,
  OPS_FIELD_RETYPE,
  OPS_REJECT,
  OPS_VERIFY,
  opsErrorText,
} from '../../../lib/payee-copy';
import { ErrorState } from '../../../ui/ErrorState';

// PUB-A2: verify (type the whole id again) or reject one request. The route does the check; this form
// only carries what the operator typed. The request id is the only identifier sent.
export function DecisionForm({
  requestId,
  last4,
  canVerify,
}: {
  requestId: string;
  last4: string;
  canVerify: boolean;
}) {
  const router = useRouter();
  const [retyped, setRetyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'verified' | 'rejected') {
    setBusy(true);
    setError(null);
    const r = await postJson<{ decision: string }>('/api/ops/payee-decisions', {
      request_id: requestId,
      merchant_id_retyped: decision === 'verified' ? retyped : '',
      decision,
      reason,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : opsErrorText(r.code));
      return;
    }
    setRetyped('');
    setDone(decision === 'verified' ? OPS_DONE_VERIFIED : OPS_DONE_REJECTED);
    router.refresh();
  }

  return (
    <div>
      {canVerify ? (
        <div className="field">
          <label htmlFor={`retype-${requestId}`}>
            {OPS_FIELD_RETYPE} (ending {last4})
          </label>
          <input
            id={`retype-${requestId}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={13}
            value={retyped}
            onChange={(e) => setRetyped(e.target.value)}
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={`reason-${requestId}`}>{OPS_FIELD_REASON}</label>
        <input
          id={`reason-${requestId}`}
          type="text"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="actions">
        {canVerify ? (
          <button
            type="button"
            className="btn"
            disabled={busy || retyped === '' || reason.trim().length < 3}
            onClick={() => void decide('verified')}
          >
            {OPS_VERIFY}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={busy || reason.trim().length < 3}
          onClick={() => void decide('rejected')}
        >
          {OPS_REJECT}
        </button>
      </div>
      <div aria-live="polite">{done}</div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}
