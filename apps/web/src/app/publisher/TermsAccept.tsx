'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import {
  TERMS_ACCEPT_BUSY,
  TERMS_ACCEPT_BUTTON,
  TERMS_ACCEPT_DONE,
  TERMS_ACCEPT_LEAD,
  TERMS_CHANGED_LEAD,
  termsErrorText,
} from '../../lib/publisher-accounts-copy';
import { ErrorState } from '../../ui/ErrorState';

// POB-P1 (J5): the publisher accepts the current publisher terms with a real action. The body is empty: the
// route takes the publisher from the session and the version from the server.
export function TermsAccept({ changed }: { changed: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setState('busy');
    setError(null);
    const r = await postJson<{ terms_version: string }>('/api/publisher/terms/accept', {});
    if (!r.ok) {
      setState('idle');
      setError(r.status === 401 ? 'Please sign in again.' : termsErrorText(r.code));
      return;
    }
    setState('done');
    router.refresh();
  }

  return (
    <div className="pk-panel" data-testid="terms-accept">
      <p>{changed ? TERMS_CHANGED_LEAD : TERMS_ACCEPT_LEAD}</p>
      <div className="pk-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={state !== 'idle'}
          onClick={() => void accept()}
        >
          {state === 'busy' ? TERMS_ACCEPT_BUSY : TERMS_ACCEPT_BUTTON}
        </button>
      </div>
      <div aria-live="polite">{state === 'done' ? TERMS_ACCEPT_DONE : null}</div>
      {error ? <ErrorState title="Could not save">{error}</ErrorState> : null}
    </div>
  );
}
