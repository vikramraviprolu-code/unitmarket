'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  LINK_FIELD_EMAIL,
  LINK_HINT_EMAIL,
  LINK_SENT,
  LINK_SUBMIT,
  linkErrorText,
} from '../../../lib/publisher-accounts-copy';
import { ErrorState } from '../../../ui/ErrorState';
import { Field } from '../form-parts';

// POB-P1 (J6): the publisher types the email of their own PayPal Business account. The publisher is the one in
// the session; nothing is used until an operator checks the address with them.
export function PaypalLinkForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setState('busy');
    setError(null);
    setFieldError(null);
    const r = await postJson<{ state: string }>('/api/publisher/paypal-link', {
      email: email.trim(),
    });
    if (!r.ok) {
      setState('idle');
      if (r.status === 401) setError('Please sign in again.');
      else if (r.code === 'invalid_email') setFieldError(linkErrorText(r.code));
      else setError(linkErrorText(r.code));
      return;
    }
    setEmail('');
    setState('sent');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void send(e)}>
      <Field id="paypal-email" label={LINK_FIELD_EMAIL} help={LINK_HINT_EMAIL} error={fieldError}>
        {(a) => (
          <input
            {...a}
            type="email"
            autoComplete="off"
            spellCheck={false}
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </Field>
      <div className="pk-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={state === 'busy' || email.trim() === ''}
        >
          {LINK_SUBMIT}
        </button>
      </div>
      <div aria-live="polite" data-testid="paypal-link-result">
        {state === 'sent' ? LINK_SENT : null}
      </div>
      {error ? <ErrorState title="Could not send">{error}</ErrorState> : null}
    </form>
  );
}
