'use client';
import { useState } from 'react';
import Link from 'next/link';
import { postJson } from '../../lib/client-api';
import {
  APPLY_NO_ACCOUNT,
  CONFIRM_BODY,
  CONFIRM_LINK,
  CONFIRM_NEXT,
  CONFIRM_REFERENCE_LABEL,
  CONFIRM_TITLE,
  FIELD_COUNTRY,
  FIELD_NAME,
  FIELD_NOTE,
  HINT_NAME,
  HINT_NOTE,
  HONEYPOT_LABEL,
  SUBMIT_BUSY,
  SUBMIT_BUTTON,
  applyErrorText,
} from '../../lib/apply-copy';
import { ErrorState } from '../../ui/ErrorState';

// PUB-APPLY: the public form. It only carries what was typed; the route checks everything again. The field
// named website is the honeypot: hidden from people, and a filled one is answered as a success and ignored.
export function ApplyForm() {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [note, setNote] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ reference: string }>('/api/applications', {
      display_name: name.trim(),
      country: country.trim().toUpperCase(),
      note: note.trim(),
      website,
    });
    setBusy(false);
    if (!r.ok) {
      setError(applyErrorText(r.status === 413 ? 'too_large' : r.code));
      return;
    }
    setReference(r.data.reference);
  }

  if (reference !== null) {
    return (
      <section className="pk-panel apply-stack" data-testid="apply-confirmation" aria-live="polite">
        <h2>{CONFIRM_TITLE}</h2>
        <p>{CONFIRM_BODY}</p>
        <div>
          <p className="muted">{CONFIRM_REFERENCE_LABEL}</p>
          <code className="apply-ref" data-testid="apply-reference">
            {reference}
          </code>
        </div>
        <p>{CONFIRM_NEXT}</p>
        <p>
          <Link className="btn" href={`/apply/status?ref=${encodeURIComponent(reference)}`}>
            {CONFIRM_LINK}
          </Link>
        </p>
      </section>
    );
  }

  return (
    <form className="pk-panel" onSubmit={submit} noValidate data-testid="apply-form">
      <p className="muted" data-testid="apply-no-account">
        {APPLY_NO_ACCOUNT}
      </p>
      {error ? <ErrorState title="Could not send">{error}</ErrorState> : null}
      <div className="field">
        <label htmlFor="apply-name">{FIELD_NAME}</label>
        <p className="hint" id="apply-name-hint">
          {HINT_NAME}
        </p>
        <input
          id="apply-name"
          name="display_name"
          type="text"
          maxLength={80}
          autoComplete="organization"
          aria-describedby="apply-name-hint"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="apply-country">{FIELD_COUNTRY}</label>
        <input
          id="apply-country"
          name="country"
          type="text"
          maxLength={2}
          autoCapitalize="characters"
          autoComplete="country"
          spellCheck={false}
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="apply-note">{FIELD_NOTE}</label>
        <p className="hint" id="apply-note-hint">
          {HINT_NOTE}
        </p>
        <textarea
          id="apply-note"
          name="note"
          rows={4}
          maxLength={200}
          aria-describedby="apply-note-hint"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="apply-hp" aria-hidden="true">
        <label htmlFor="apply-website">{HONEYPOT_LABEL}</label>
        <input
          id="apply-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={busy || name.trim() === '' || country.trim() === '' || note.trim() === ''}
      >
        {busy ? SUBMIT_BUSY : SUBMIT_BUTTON}
      </button>
    </form>
  );
}
