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
import { FIELD_NOTE_HINT, payeeErrorField } from '../../../lib/publisher-forms-copy';
import { ErrorState } from '../../../ui/ErrorState';
import { Field } from '../form-parts';

// PUB-A2: ask for a payee change. The body is the new merchant id and a note; the publisher is the one
// in the session. Nothing changes until an operator verifies the request.
// PUB-UI-FORMS: the help sits under each field, and a problem with the id or the note is shown beside it.
export function RequestForm() {
  const router = useRouter();
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [merchantError, setMerchantError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setState('busy');
    setError(null);
    setMerchantError(null);
    setNoteError(null);
    const r = await postJson<{ request_id: string }>('/api/publisher/payee-requests', {
      merchant_id: merchant,
      note,
    });
    if (!r.ok) {
      setState('idle');
      if (r.status === 401) {
        setError('Please sign in again.');
        return;
      }
      const text = requestErrorText(r.code);
      const field = payeeErrorField(r.code);
      if (field === 'merchant') setMerchantError(text);
      else if (field === 'note') setNoteError(text);
      else setError(text);
      return;
    }
    setMerchant('');
    setNote('');
    setState('sent');
    router.refresh();
  }

  return (
    <section className="pk-section" aria-labelledby="payee-request-heading">
      <h2 id="payee-request-heading">{REQUEST_HEADING}</h2>
      <div className="pk-panel">
        <p>{REQUEST_LEDE}</p>
        <form onSubmit={(e) => void send(e)}>
          <Field
            id="payee-merchant"
            label={FIELD_MERCHANT}
            help={FIELD_MERCHANT_HINT}
            error={merchantError}
          >
            {(a) => (
              <input
                {...a}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={13}
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
              />
            )}
          </Field>
          <Field id="payee-note" label={FIELD_NOTE} help={FIELD_NOTE_HINT} error={noteError}>
            {(a) => (
              <input
                {...a}
                type="text"
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <div className="pk-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={state === 'busy' || merchant === '' || note.trim() === ''}
            >
              {REQUEST_SUBMIT}
            </button>
          </div>
        </form>
        <div aria-live="polite" data-testid="payee-request-result">
          {state === 'sent' ? REQUEST_SENT : null}
        </div>
        {error ? <ErrorState title="Could not send">{error}</ErrorState> : null}
      </div>
    </section>
  );
}
