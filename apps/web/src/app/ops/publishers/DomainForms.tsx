'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import { importErrorText } from '../../../lib/web-import-copy';
import {
  FIELD_REASON,
  OPS_DOMAIN_DONE_REMOVED,
  OPS_DOMAIN_DONE_VOUCHED,
  OPS_REMOVE_ADDRESS_BUTTON,
  OPS_VOUCH_BUTTON,
} from '../../../lib/ops-publishers-copy';
import { OPS_NEEDS_CODE } from '../../../lib/ops-copy';
import { ErrorState } from '../../../ui/ErrorState';

// DOMAIN-PROOF-2 (D-116): vouch for, or remove, one web address of a publisher. The routes check the operator, the
// second factor and the reason again; this form only carries the address id and the reason the operator typed.
export function DomainForms({
  domainId,
  host,
  pending,
  hasCode,
}: {
  domainId: string;
  host: string;
  /** Only a pending address can be vouched for. */
  pending: boolean;
  hasCode: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(path: 'vouch' | 'remove') {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await postJson<{ host: string }>(`/api/ops/publishers/domains/${path}`, {
      domain_id: domainId,
      reason,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Please sign in again.' : importErrorText(r.code));
      return;
    }
    setReason('');
    setDone(path === 'vouch' ? OPS_DOMAIN_DONE_VOUCHED : OPS_DOMAIN_DONE_REMOVED);
    router.refresh();
  }

  const off = !hasCode || busy || reason.trim().length < 3;
  return (
    <div>
      <div className="field">
        <label htmlFor={`domain-reason-${domainId}`}>
          {FIELD_REASON} ({host})
        </label>
        <input
          id={`domain-reason-${domainId}`}
          type="text"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="actions">
        {pending ? (
          <button type="button" className="btn" disabled={off} onClick={() => void send('vouch')}>
            {OPS_VOUCH_BUTTON}
          </button>
        ) : null}{' '}
        <button type="button" className="btn" disabled={off} onClick={() => void send('remove')}>
          {OPS_REMOVE_ADDRESS_BUTTON}
        </button>
        {hasCode ? null : <span className="muted"> {OPS_NEEDS_CODE}</span>}
      </div>
      <div aria-live="polite">{done}</div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </div>
  );
}
