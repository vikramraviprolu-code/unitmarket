'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  FIELD_MERCHANT,
  FIELD_MERCHANT_HINT,
  FIELD_NOTE,
  REQUEST_HEADING,
  REQUEST_LEDE,
  REQUEST_SENT,
  REQUEST_SUBMIT,
  requestErrorText,
} from '../../../lib/payee-copy';
import { ErrorState } from '../../../ui/ErrorState';

// PUB-A2: ask for a payee change. The body is the new merchant id and a note; the publisher is the one
// in the session. Nothing changes until an operator verifies the request.
export function RequestForm() {
  const router = useRouter();
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setState('busy');
    setError(null);
    const r = await postJson<{ request_id: string }>('/api/publisher/payee-requests', {
      merchant_id: merchant,
      note,
    });
    if (!r.ok) {
      setState('idle');
      setError(r.status === 401 ? 'Please sign in again.' : requestErrorText(r.code));
      return;
    }
    setMerchant('');
    setNote('');
    setState('sent');
    router.refresh();
  }

  return (
    <section aria-labelledby="payee-request-heading">
      <h2 id="payee-request-heading">{REQUEST_HEADING}</h2>
      <p>{REQUEST_LEDE}</p>
      <form onSubmit={(e) => void send(e)}>
        <div className="field">
          <label htmlFor="payee-merchant">{FIELD_MERCHANT}</label>
          <input
            id="payee-merchant"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={13}
            aria-describedby="payee-merchant-hint"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
          />
          <p id="payee-merchant-hint" className="muted">
            {FIELD_MERCHANT_HINT}
          </p>
        </div>
        <div className="field">
          <label htmlFor="payee-note">{FIELD_NOTE}</label>
          <input
            id="payee-note"
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="btn"
          disabled={state === 'busy' || merchant === '' || note.trim() === ''}
        >
          {REQUEST_SUBMIT}
        </button>
      </form>
      <div aria-live="polite" data-testid="payee-request-result">
        {state === 'sent' ? REQUEST_SENT : null}
      </div>
      {error ? <ErrorState title="Could not send">{error}</ErrorState> : null}
    </section>
  );
}
