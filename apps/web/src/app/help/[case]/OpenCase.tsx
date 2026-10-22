'use client';
import { useState } from 'react';
import { postJson } from '../../../lib/client-api';
import { StatusBanner } from '../../../ui/StatusBanner';
import { ErrorState } from '../../../ui/ErrorState';

export function OpenCase({ note }: { note: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setState('busy');
    setError(null);
    const r = await postJson<{ case_id: string }>('/api/cases', { note });
    if (!r.ok) {
      setState('idle');
      setError(
        r.status === 401
          ? 'Please sign in to ask for help.'
          : r.code === 'recovery_not_wired'
            ? 'Help requests are not available in this build yet. Your item and money are safe.'
            : r.message,
      );
      return;
    }
    setState('done');
  }
  return (
    <>
      <button type="button" className="btn" onClick={() => void open()} disabled={state !== 'idle'}>
        Ask us to look at this
      </button>
      <div aria-live="polite">
        {state === 'done' ? (
          <StatusBanner tone="success" title="We have it">
            We opened a case and will update this page.
          </StatusBanner>
        ) : null}
        {error ? <ErrorState title="Could not open a case">{error}</ErrorState> : null}
      </div>
    </>
  );
}
